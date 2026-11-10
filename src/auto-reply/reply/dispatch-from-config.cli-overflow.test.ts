import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTestRunAdmission } from "../../agents/admitted-run-context.test-support.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../../agents/cli-output-stream-limits.js";
import { runPreparedCliAgent } from "../../agents/cli-runner.js";
import { createPreparedCliContext } from "../../agents/cli-runner/prepared-context.test-support.js";
import { shutdownProcessSupervisor } from "../../process/supervisor/index.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import type { ReplyPayload } from "../types.js";
import { emptyConfig } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterAll(shutdownProcessSupervisor);
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetInboundDedupe();
});

// Production child/supervisor/CLI runner -> public custom reply resolver ->
// real dispatch ledger/completion reconciliation and source-owner settlement.
// The final transport adapter is in memory: this proves host handoff exactly
// once, NOT network delivery, restart durability, or a live provider request.
it("delivers one recovered CLI answer and settles the requester once despite duplicate terminal/input records", async ({
  signal,
}) => {
  const root = dirs.make("openclaw-cli-requester-overflow-");
  const script = path.join(root, "fixture.mjs");
  const starts = path.join(root, "starts");
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(starts)}, "spawn\\n");
const line = (record) => JSON.stringify(record) + "\\n";
const padding = line({type:"system",subtype:"fixture_padding"});
const result = line({type:"result",subtype:"success",session_id:"requester-cli-session",result:"Recovered requester answer"});
await new Promise((resolve) => process.stdout.write(padding.repeat(${CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1}) + result + result, resolve));
`,
  );
  const sessionKey = "agent:main:discord:direct:overflow-requester";
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    SessionKey: sessionKey,
    MessageSid: "overflow-request-1",
    To: "discord:overflow-requester",
    ChatType: "direct",
  });
  const deliver = vi.fn(async (_payload: ReplyPayload) => {});
  const dispatcher = createReplyDispatcher({ deliver });
  const replayDispatcher = createReplyDispatcher({ deliver });
  let options: InternalGetReplyOptions | undefined;
  const resolver = vi.fn(async (_ctx: unknown, opts: InternalGetReplyOptions | undefined) => {
    options = opts;
    const operation = opts?.replyOperation;
    if (!operation) {
      throw new Error("fixture needs the actual requester operation");
    }
    const backend = {
      command: process.execPath,
      args: [script],
      input: "stdin" as const,
      output: "jsonl" as const,
      jsonlDialect: "claude-stream-json" as const,
      sessionMode: "none" as const,
      serialize: false,
    };
    const context = createPreparedCliContext(
      {
        provider: "overflow-fixture-cli",
        model: "fixture-model",
        runId: "overflow-requester-run",
        sessionKey,
        sessionId: operation.sessionId,
        sessionFile: sessionKey,
        workspaceDir: root,
        agentId: "main",
        config: { plugins: { enabled: false } },
        timeoutMs: 30_000,
        replyOperation: operation,
        abortSignal: opts?.abortSignal,
        terminalReplyExpectation: "required",
        trigger: "user",
        messageChannel: "discord",
      },
      { id: "overflow-fixture-cli", config: backend, bundleMcp: false },
      { workspaceDir: root },
    );
    return withTestRunAdmission(context.params, async (admitted) => {
      context.params.admittedRunContext = admitted;
      const result = await runPreparedCliAgent(context);
      expect(result.meta.error).toBeUndefined();
      return result.payloads;
    });
  });
  try {
    const result = await withinTest(
      dispatchReplyFromConfig({ cfg: emptyConfig, ctx, dispatcher, replyResolver: resolver }),
      signal,
    );
    await withinTest(settleReplyDispatcher({ dispatcher }), signal);
    await withinTest(
      options?.replyOperation?.ownerSettlement ?? Promise.reject(new Error("no owner")),
      signal,
    );
    expect(result.counts.final).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ text: "Recovered requester answer" });
    expect(resolveReplyOperationRunState(options)?.replyCompletion).toEqual({
      expectation: "required",
      outcome: "delivered",
    });
    expect(options?.replyOperation?.result).toEqual({ kind: "completed" });
    await withinTest(
      dispatchReplyFromConfig({
        cfg: emptyConfig,
        ctx,
        dispatcher: replayDispatcher,
        replyResolver: resolver,
      }),
      signal,
    );
    await withinTest(settleReplyDispatcher({ dispatcher: replayDispatcher }), signal);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(starts, "utf8")).toBe("spawn\n");
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally {
    dispatcher.markComplete();
    replayDispatcher.markComplete();
    options?.replyOperation?.complete();
    await Promise.all([
      settleReplyDispatcher({ dispatcher }),
      settleReplyDispatcher({ dispatcher: replayDispatcher }),
    ]);
  }
});
