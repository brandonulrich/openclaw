import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { shutdownProcessSupervisor } from "../../process/supervisor/index.js";
import { withTestRunAdmission } from "../admitted-run-context.test-support.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../cli-output-stream-limits.js";
import { CLI_STREAM_JSON_MISSING_RESULT_ERROR } from "../cli-output-stream-output.js";
import { createCliEventHandlers } from "./execute-events.js";
import { executeCliProcess } from "./execute-process.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import { createPreparedCliContext } from "./prepared-context.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterAll(shutdownProcessSupervisor);
afterEach(() => {
  resetDiagnosticStateForTest();
  vi.useRealTimers();
});

// A deterministic CLI wire fixture, not a provider/model call. File-watch acks
// prevent pipe coalescing from hiding the diagnostic state between tool phases.
const fixture = String.raw`
import fs from "node:fs";
import path from "node:path";
const [root, mode, maxLines, maxChars, maxLine] = process.argv.slice(2);
const line = (record) => JSON.stringify(record) + "\n";
const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
async function checkpoint(label, records) {
  const ack = path.join(root, label);
  await new Promise((resolve, reject) => {
    const watcher = fs.watch(root, () => {
      if (fs.existsSync(ack)) { watcher.close(); resolve(); }
    });
    watcher.on("error", reject);
    process.stdout.write(records.map(line).join("") +
      line({type: "system", fixture_checkpoint: label}));
  });
}
await checkpoint("started", [{
  type: "assistant",
  message: {content: [{type: "tool_use", id: "agent-1", name: "Agent", input: {prompt: "fixture"}}]},
}]);
if (mode.startsWith("lines")) {
  const ordinary = line({type: "system", subtype: "fixture_ordinary"});
  for (let count = 0; count < Number(maxLines) + 1; count += 1) await write(ordinary);
}
if (mode === "chars") {
  const ordinary = line({type: "system", subtype: "fixture_ordinary", padding: "x".repeat(65536)});
  for (let chars = 0; chars <= Number(maxChars); chars += ordinary.length) await write(ordinary);
}
if (mode === "oversize" || mode === "lines-oversize") await write("x".repeat(Number(maxLine) + 1));
if (mode === "lines" || mode === "chars") {
  await write(line({type: "assistant", message: {content: [
    {type: "tool_use", id: "must-not-start", name: "Bash", input: {command: "not executed"}},
  ]}}));
}
await checkpoint("unattributed", [{
  type: "assistant", parent_tool_use_id: "not-agent-1",
  message: {content: [{type: "text", text: "not attributable to the active Agent"}]},
}]);
if (mode === "lines" || mode === "chars") await write(line({
  type: "user", message: {content: [
    {type: "tool_result", tool_use_id: "never-started", content: "unrelated"},
  ]},
}));
for (const label of ["progress1", "progress2"]) {
  await checkpoint(label, [{
    type: "assistant", parent_tool_use_id: "agent-1",
    message: {content: [{type: "text", text: "attributable child progress"}]},
  }]);
}
const result = {type: "user", message: {content: [
  {type: "tool_result", tool_use_id: "agent-1", content: "child complete"},
]}};
await checkpoint("settled", [result, result]);
if (mode !== "missing" && mode !== "lines-missing") await write(line({
  type: "result", subtype: "success", is_error: false,
  session_id: "fixture-cli-session", result: "terminal answer",
}));
`;

async function runFixture(
  mode: "normal" | "lines" | "chars" | "missing" | "oversize" | "lines-missing" | "lines-oversize",
) {
  const root = tempDirs.make("openclaw-cli-overflow-");
  const script = path.join(root, "fixture.mjs");
  fs.writeFileSync(script, fixture);
  const runId = `overflow-${mode}`;
  const backend = {
    command: process.execPath,
    output: "jsonl" as const,
    jsonlDialect: "claude-stream-json" as const,
    serialize: false,
  };
  const context = createPreparedCliContext(
    {
      provider: "claude-cli",
      model: "fixture-model",
      runId,
      sessionKey: `agent:test:${runId}`,
      agentId: "test",
      config: { plugins: { enabled: false }, diagnostics: { enabled: true } },
      timeoutMs: 30_000,
    },
    { id: "claude-cli", config: backend, bundleMcp: false },
    { workspaceDir: root },
  );
  return withTestRunAdmission(context.params, async (admitted) => {
    context.params.admittedRunContext = admitted;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner(context.params);
    context.params.diagnosticOwner = owner;
    markDiagnosticEmbeddedRunStarted({ ...context.params, owner });
    const tracking = createCliToolTracking(context);
    const events = createCliEventHandlers({
      context,
      toolTracking: tracking,
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const toolEvents: Array<Record<string, unknown>> = [];
    const stopEvents = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "tool") {
        toolEvents.push(event.data);
      }
    });
    setDiagnosticsEnabledForProcess(true);
    const stopDiagnostics = onTrustedInternalDiagnosticEvent(() => {});
    const diagnostics = createClaudeCliModelCallDiagnostics({
      context,
      prompt: "fixture only",
      transport: "stdio",
    });
    if (!diagnostics) {
      throw new Error("Fixture requires real model-call diagnostics");
    }
    const snapshots = new Map<string, ReturnType<typeof getDiagnosticSessionActivitySnapshot>>();
    const completedCheckpoints = new Set<string>();
    let tail = "";
    const observe = diagnostics.observeCliOutput.bind(diagnostics);
    vi.spyOn(diagnostics, "observeCliOutput").mockImplementation((chunk, stream, bytes) => {
      observe(chunk, stream, bytes);
      if (stream !== "stdout") {
        return;
      }
      tail = (tail + chunk).slice(-512);
      for (const label of ["started", "unattributed", "progress1", "progress2", "settled"]) {
        if (!tail.includes(`"fixture_checkpoint":"${label}"`) || completedCheckpoints.has(label)) {
          continue;
        }
        completedCheckpoints.add(label);
        // consumeStdout invokes diagnostics before the parser. Join the real
        // diagnostic event queue after that same synchronous parser push.
        queueMicrotask(() => {
          void waitForDiagnosticEventsDrained().then(() => {
            snapshots.set(label, getDiagnosticSessionActivitySnapshot(context.params));
            vi.setSystemTime(Date.now() + 16 * 60_000);
            fs.writeFileSync(path.join(root, label), "");
          });
        });
      }
    });
    try {
      const output = await executeCliProcess({
        context,
        backend,
        assertCurrent: () => {},
        events,
        toolTracking: tracking,
        diagnostics,
        nodePlacement: null,
        useManagedClaudeLiveSession: false,
        useResume: false,
        executionCommand: process.execPath,
        executionLeadingArgv: [],
        resolveExecutionArgs: () => [
          script,
          root,
          mode,
          String(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines),
          String(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars),
          String(CLI_STREAM_JSON_OUTPUT_LIMITS.maxPendingLineChars),
        ],
        env: {},
        prompt: "fixture only",
        noOutputTimeoutMs: 30_000,
        outputMode: "jsonl",
        logOutputText: false,
        cliTurnStartedAt: Date.now(),
        observeForkSuccessor: () => {},
      });
      return { output, snapshots, toolEvents, activeTools: events.activeParsedToolCount() };
    } finally {
      stopEvents();
      stopDiagnostics();
      closeDiagnosticEmbeddedRunOwner(owner);
      tracking.finalizeCapture(events.finalizeParsedTools);
    }
  });
}

it.each(["normal", "lines", "chars"] as const)(
  "recovers the terminal reply after %s output with outstanding Agent settlement",
  async (mode) => {
    const run = await runFixture(mode);
    expect(run.output).toMatchObject({ text: "terminal answer", sessionId: "fixture-cli-session" });
    expect(run.toolEvents.filter((e) => e.phase === "start").map((e) => e.toolCallId)).toEqual([
      "agent-1",
    ]);
    expect(run.toolEvents.filter((e) => e.phase === "result").map((e) => e.toolCallId)).toEqual([
      "agent-1",
    ]);
    expect(run.activeTools).toBe(0);
    expect(run.snapshots.get("unattributed")).toMatchObject({
      activeToolCallId: "agent-1",
      lastProgressAgeMs: 16 * 60_000,
      lastProgressReason: "tool:Agent:started",
    });
    for (const label of ["progress1", "progress2"]) {
      expect(run.snapshots.get(label)).toMatchObject({
        activeToolCallId: "agent-1",
        lastProgressAgeMs: 0,
        lastProgressReason: "tool:Agent:subagent_progress",
      });
    }
  },
);

it("rejects a real child exit without a terminal result", async () => {
  await expect(runFixture("missing")).rejects.toThrow(CLI_STREAM_JSON_MISSING_RESULT_ERROR);
});

it("keeps the single-line allocation guard fatal on the real child path", async () => {
  await expect(runFixture("oversize")).rejects.toThrow(
    `CLI JSONL line exceeded ${CLI_STREAM_JSON_OUTPUT_LIMITS.maxPendingLineChars} characters; refusing to parse output.`,
  );
});

it("does not accept an exhausted child exit without a terminal result", async () => {
  await expect(runFixture("lines-missing")).rejects.toThrow(
    `CLI JSONL output exceeded ${CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines} lines; refusing to parse output.`,
  );
});

it("keeps the per-line guard fatal after cumulative exhaustion", async () => {
  await expect(runFixture("lines-oversize")).rejects.toThrow(
    `CLI JSONL line exceeded ${CLI_STREAM_JSON_OUTPUT_LIMITS.maxPendingLineChars} characters; refusing to parse output.`,
  );
});
