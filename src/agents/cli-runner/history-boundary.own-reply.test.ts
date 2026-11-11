import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sessionTranscript from "../../config/sessions.js";
import {
  loadTranscriptEvents,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import * as internalReply from "../../gateway/internal-source-reply-persistence.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { sendHandlers } from "../../gateway/server-methods/send.js";
import { createAgentRuntimeGatewayClientForTests } from "../../gateway/server-methods/send.test-helpers.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  captureAgentRunTerminalPersistence,
  bindAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
  clearAgentRunTerminalWriteContext,
} from "../../infra/agent-run-terminal-writes.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { mirrorDeliveredSourceReplyToTranscript } from "../../infra/outbound/source-reply-mirror.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { jsonResult } from "../tools/common.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";
import { executePreparedCliRun } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "./execute.test-support.js";
import { createHistoryBoundaryFixture, history } from "./history-boundary.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const dirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "cli-own-reply-",
);
afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});
type Fixture = Awaited<ReturnType<typeof createHistoryBoundaryFixture>>;
type Params = PreparedCliRunContext["params"];
const fixture = () => createHistoryBoundaryFixture(dirs);
const answer = (params: Params) =>
  persistCliAssistantTranscript({
    runParams: { ...params, persistAssistantTranscript: true },
    text: "FINAL_REPLY",
    modelId: "test-model",
    stopReason: "stop",
  });
function mirror(
  f: Fixture,
  writeContext = undefined as ReturnType<typeof captureAgentRunTerminalPersistence>["writeContext"],
) {
  const params = {
    action: "send",
    channel: "testchat",
    cfg: { session: { store: f.target.storePath } },
    actionParams: { target: "peer-1", message: "OWN_PROGRESS" },
    toolContext: { currentChannelProvider: "testchat", currentChannelId: "peer-1" },
    ...f.target,
    sourceReplyFinal: false,
    deliveredPayload: { ok: true, messageId: "progress" },
    writeContext,
  };
  return runWithoutOwnedSessionTranscriptWrites(() =>
    mirrorDeliveredSourceReplyToTranscript(params),
  );
}
async function webchat(f: Fixture, params: Params) {
  return runWithoutOwnedSessionTranscriptWrites(() =>
    runMessageAction({
      cfg: { session: { store: f.target.storePath } },
      action: "send",
      params: { message: "OWN_PROGRESS" },
      ...f.target,
      runId: params.runId,
      sourceReplyDeliveryMode: "message_tool_only",
      sourceReplyFinal: false,
      toolContext: { currentChannelProvider: "webchat" },
    }),
  );
}

function setupGateway(f: Fixture) {
  const cfg = { session: { store: f.target.storePath } };
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "synthetic",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
          }),
          actions: {
            describeMessageTool: () => ({ actions: ["send"] }),
            supportsAction: ({ action }: { action: string }) => action === "send",
            handleAction: async () =>
              jsonResult({ ok: true, messageId: "synthetic-platform-receipt" }),
          },
        },
      },
    ]),
  );
}
async function gatewayProgress(f: Fixture, params: Params) {
  const cfg = { session: { store: f.target.storePath } };
  const authority = getAgentRunContext(params.runId)?.delegatedAuthority;
  expect(authority).toBeDefined();
  const toolContext = { currentChannelProvider: "telegram", currentChannelId: "peer-1" };
  const token = mintMessageActionTurnCapability({ ...f.target, runId: params.runId, toolContext });
  const client = createAgentRuntimeGatewayClientForTests({
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: f.target.sessionKey,
    operationalRunInstance: authority!.operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority! },
    messageActionContext: {
      expiresAtMs: Date.now() + 60_000,
      sessionId: f.target.sessionId,
      sourceReplyFinal: false,
      toolContext,
      turnCapability: token,
    },
  });
  const respond = vi.fn();
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  try {
    await runWithoutOwnedSessionTranscriptWrites(() =>
      expectDefined(
        sendHandlers["message.action"],
        "message.action handler",
      )({
        params: {
          action: "send",
          channel: "telegram",
          params: { target: "peer-1", message: "OWN_PROGRESS" },
          sessionKey: f.target.sessionKey,
          sessionId: f.target.sessionId,
          agentId: "main",
          idempotencyKey: "synthetic-progress",
        },
        respond,
        context,
        client,
        req: { type: "req", id: "synthetic-send", method: "message.action" },
        isWebchatConnect: () => false,
      }),
    );
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(context.logGateway.warn).not.toHaveBeenCalled();
  } finally {
    revokeMessageActionTurnCapability(token);
  }
}

function setupLocal(f: Fixture, onSend = () => {}) {
  const cfg = { session: { store: f.target.storePath } };
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "synthetic",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
          }),
          messaging: { targetResolver: { looksLikeId: () => true } },
          outbound: {
            deliveryMode: "direct",
            sendText: async () => {
              onSend();
              return { channel: "telegram", messageId: "local-receipt" };
            },
          },
        },
      },
    ]),
  );
}
const local = (f: Fixture, params: Params) =>
  runWithoutOwnedSessionTranscriptWrites(() =>
    runMessageAction({
      ...f.target,
      cfg: { session: { store: f.target.storePath } },
      runId: params.runId,
      action: "send",
      params: { channel: "telegram", target: "peer-1", message: "OWN_PROGRESS" },
      sourceReplyFinal: false,
      toolContext: { currentChannelProvider: "telegram", currentChannelId: "peer-1" },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: { currentChannelProvider: "telegram", currentChannelId: "peer-1" },
      },
    }),
  );

describe("CLI account coverage for its own detached source replies", () => {
  it.each(["channel", "webchat", "local"] as const)(
    "keeps %s progress contiguous through final persistence and reseed",
    async (kind) => {
      const f = await fixture();
      await f.seed();
      if (kind === "local") {
        setupLocal(f);
      }
      await f.run("epoch-a", async (allowed, params) => {
        expect(allowed).toBe(true);
        if (kind === "channel") {
          expect(
            await mirror(f, captureAgentRunTerminalPersistence(params.runId).writeContext),
          ).toBe(true);
        } else if (kind === "local") {
          await local(f, params);
        } else {
          expect((await webchat(f, params)).payload).toMatchObject({
            sourceReplyTranscriptOwner: true,
          });
        }
        expect((await answer(params)).owned).toBe(true);
      });
      await f.run("epoch-a", async (allowed, params) => {
        expect(allowed).toBe(true);
        expect(await history(allowed, params)).toContain("OWN_PROGRESS");
        expect(await history(allowed, params)).toContain("FINAL_REPLY");
      });
    },
  );

  it("never lends coverage from a missing or wrong run", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (allowed, params) => {
      expect(allowed).toBe(true);
      expect(await mirror(f, captureAgentRunTerminalPersistence("not-this-run").writeContext)).toBe(
        true,
      );
      await answer(params);
    });
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("does not cover another session with the sending run's writer", async () => {
    const f = await fixture();
    const other = await fixture();
    await f.seed();
    await other.seed();
    await f.run("epoch-a", async (_allowed, params) => {
      await mirror(other, captureAgentRunTerminalPersistence(params.runId).writeContext);
    });
    await other.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it.each(["channel", "local"] as const)(
    "retains a delivered %s row unowned after candidate replacement",
    async (kind) => {
      const f = await fixture();
      await f.seed();
      let replace = () => {};
      if (kind === "local") {
        setupLocal(f, () => replace());
      }
      await f.run("epoch-a", async (_allowed, params) => {
        const captured = captureAgentRunTerminalPersistence(params.runId).writeContext;
        const before = loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary;
        const instance = getAgentRunContext(params.runId)!.delegatedAuthority!
          .operationalRunInstance;
        replace = () => clearAgentRunTerminalWriteContext(instance);
        if (kind === "channel") {
          replace();
          expect(await mirror(f, captured)).toBe(true);
        } else {
          await local(f, params);
        }
        expect(JSON.stringify(await loadTranscriptEvents(f.target))).toContain("OWN_PROGRESS");
        expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary).toEqual(before);
      });
      await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
    },
  );

  it.each(["channel", "webchat"] as const)(
    "checks captured authority at the %s append, not only wrapper entry",
    async (kind) => {
      const f = await fixture();
      await f.seed();
      await f.run("epoch-a", async (_allowed, params) => {
        const authority = getAgentRunContext(params.runId)!.delegatedAuthority!;
        const before = await loadTranscriptEvents(f.target);
        const clear = () => clearAgentRunTerminalWriteContext(authority.operationalRunInstance);
        if (kind === "channel") {
          const append = sessionTranscript.appendAssistantMessageToSessionTranscript;
          vi.spyOn(
            sessionTranscript,
            "appendAssistantMessageToSessionTranscript",
          ).mockImplementationOnce(async (options) => {
            await Promise.resolve();
            clear();
            return append(options);
          });
        } else {
          const persist = internalReply.persistInternalSourceReply;
          vi.spyOn(internalReply, "persistInternalSourceReply").mockImplementationOnce(
            async (options) => {
              await Promise.resolve();
              clear();
              return persist(options);
            },
          );
        }
        const pending =
          kind === "channel"
            ? mirror(f, captureAgentRunTerminalPersistence(params.runId).writeContext)
            : webchat(f, params);
        if (kind === "channel") {
          expect(await pending).toBe(true);
          expect(JSON.stringify(await loadTranscriptEvents(f.target))).toContain("OWN_PROGRESS");
          expect((await loadTranscriptEvents(f.target)).length).toBe(before.length + 1);
        } else {
          await expect(pending).rejects.toThrow("Terminal write owner changed");
          expect(await loadTranscriptEvents(f.target)).toEqual(before);
        }
      });
    },
  );

  it("never recaptures a replacement writer after awaiting private-sink routing", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (_allowed, params) => {
      const authority = getAgentRunContext(params.runId)!.delegatedAuthority!;
      const pending = webchat(f, params);
      clearAgentRunTerminalWriteContext(authority.operationalRunInstance);
      const replacement = vi.fn();
      bindAgentRunTerminalWriteContext(authority, {
        run: <T>(write: () => T): T => {
          replacement();
          return write();
        },
      });
      await expect(pending).rejects.toThrow("Terminal write owner changed");
      expect(replacement).not.toHaveBeenCalled();
    });
  });

  it("joins accepted private-sink persistence before retiring terminal ownership", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (_allowed, params) => {
      const entered = createDeferred(),
        release = createDeferred();
      const persist = internalReply.persistInternalSourceReply;
      vi.spyOn(internalReply, "persistInternalSourceReply").mockImplementationOnce(
        async (options) => {
          entered.resolve();
          await release.promise;
          return persist(options);
        },
      );
      const pending = webchat(f, params);
      let drain: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Private persistence never started",
        );
        let drained = false;
        drain = drainAgentRunTerminalWrites(
          getAgentRunContext(params.runId)!.delegatedAuthority!.operationalRunInstance,
        ).then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([pending, drain]);
      }
      expect((await pending).payload).toMatchObject({ sourceReplyTranscriptOwner: true });
    });
  });

  it("keeps the account-change refusal after an owned mirror", async () => {
    const f = await fixture();
    await f.seed();
    await f.run("epoch-a", async (_allowed, params) => {
      expect(await mirror(f, captureAgentRunTerminalPersistence(params.runId).writeContext)).toBe(
        true,
      );
      await answer(params);
    });
    await f.run("epoch-b", async (allowed, params) => {
      expect(allowed).toBe(false);
      expect(await history(allowed, params)).toBeUndefined();
    });
    expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary?.state).toBe("unknown");
  });

  it("never repairs an unknown boundary by appending an own reply", async () => {
    const f = await fixture();
    await f.manager().appendMessageAsync({ role: "user", content: "UNOWNED", timestamp: 1 });
    await f.run("epoch-a", async (allowed, params) => {
      expect(allowed).toBe(false);
      await mirror(f, captureAgentRunTerminalPersistence(params.runId).writeContext);
      await answer(params);
    });
    await f.run("epoch-a", async (allowed) => expect(allowed).toBe(false));
  });

  it("synthetic CLI stream calls isolated Gateway message.action and keeps progress before its final row", async () => {
    const f = await fixture();
    await f.seed();
    setupGateway(f);
    await f.run("epoch-a", async (allowed, params) => {
      expect(allowed).toBe(true);
      const context = buildPreparedCliRunContext({
        provider: "codex-cli",
        sessionTarget: f.target,
        workspaceDir: params.workspaceDir,
        backend: {
          command: "/synthetic-cli",
          args: [],
          output: "json",
          input: "stdin",
          systemPromptFileArg: undefined,
        },
      });
      context.params = params;
      supervisorSpawnMock.mockImplementationOnce(async () => {
        await gatewayProgress(f, params);
        return createManagedRun({
          ...createSuccessfulProcessExit(),
          stdout: JSON.stringify({ result: "SYNTHETIC_FINAL", session_id: "synthetic-native" }),
        });
      });
      const output = await executePreparedCliRun(context);
      expect(output.text).toBe("SYNTHETIC_FINAL");
      expect((await answer(params)).owned).toBe(true);
    });
    await f.run("epoch-a", async (allowed, params) => {
      expect(allowed).toBe(true);
      expect(await history(allowed, params)).toContain("OWN_PROGRESS");
    });
  });
});
