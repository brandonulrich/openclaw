import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { withSessionTranscriptHydrationCaller } from "../../config/sessions/session-transcript-hydration-caller.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createHistoryBoundaryFixture, history } from "./history-boundary.test-support.js";

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "cli-history-clearing-reset-",
);

type Fixture = Awaited<ReturnType<typeof createHistoryBoundaryFixture>>;
const maxBytes = 1024 * 1024;
const oversized = "OMITTED_PRIVATE_PAYLOAD_" + "x".repeat(maxBytes);
const facts = async (f: Fixture) =>
  (await readSessionTranscriptAnchorsAsync(f.target, { entryIds: [], contextAuthority: true }))
    .contextAuthority;
const append = (manager: SessionManager, content: string) =>
  manager.appendMessageAsync({ role: "user", content, timestamp: 1 });

async function unknownHistory(limit: "events" | "bytes", long = false) {
  const f = await createHistoryBoundaryFixture(sessionDirs);
  const manager = await SessionManager.openAsync(f.target);
  await f.run("epoch-a", async (allowed) => {
    expect(allowed).toBe(true);
    await append(manager, "OLD_ACCOUNT_CANARY");
  });
  const previousBoundary = (await facts(f))?.entry?.cliHistoryBoundary;
  if (previousBoundary?.state !== "known") {
    throw new Error("Expected the seeded account boundary to be known");
  }
  if (limit === "events" || long) {
    for (let index = 0; index < 101; index++) {
      await append(manager, `LEGACY_PRIVATE_TURN_${index}`);
    }
  }
  if (limit === "bytes") {
    await append(manager, oversized);
  }
  const anchor = await append(manager, "PRE_RESET_ANCHOR");
  if (limit === "events" || long) {
    expect(manager.getEntries().length).toBeGreaterThan(100);
  }
  const bytes = Buffer.byteLength(JSON.stringify(manager.getEntries()), "utf8");
  if (limit === "bytes") {
    expect(bytes).toBeGreaterThan(maxBytes);
  } else {
    expect(bytes).toBeLessThan(maxBytes);
  }
  await f.run("epoch-b", async (allowed, params) => {
    expect(allowed).toBe(false);
    expect(await history(allowed, params)).toBeUndefined();
  });
  expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
  return { f, manager, anchor, previousBoundary };
}

async function boundedBranch(f: Fixture) {
  let truncated = false;
  const manager = await withSessionTranscriptHydrationCaller("cli-context", () =>
    SessionManager.openBoundedAsync(f.target, {
      maxBytes,
      maxEvents: 100,
      onTruncated: () => {
        truncated = true;
      },
    }),
  );
  expect(truncated).toBe(true);
  return manager.getBranch();
}

describe("CLI history after a clearing reset of a bounded transcript", () => {
  it.each(["events", "bytes"] as const)(
    "starts a new account boundary after /new despite the %s limit",
    async (limit) => {
      // Both histories exceed 100 entries; the byte case exceeds 1 MiB too,
      // with an oversized row near the tip so the byte cap, not the count, stops it.
      const { f, manager, anchor, previousBoundary } = await unknownHistory(limit, true);
      const reset = await manager.appendResetBoundaryAsync("new");
      const branch = await boundedBranch(f);
      expect(branch.findIndex((entry) => entry.id === reset)).toBeGreaterThan(0);
      expect(branch.some((entry) => entry.id === anchor)).toBe(true);
      expect(buildSessionContext(branch).messages).toEqual([]);

      await f.run("epoch-b", async (allowed) => {
        // On the base this is the regression failure: truncation alone refuses
        // the empty context even though its complete clearing reset is visible.
        expect(allowed).toBe(true);
        const writer = expectDefined(getCliHistoryWriter(f.target), "fresh history writer");
        await writer.assertReadable();
        await append(await SessionManager.openAsync(f.target), "FRESH_ACCOUNT_CANARY");
      });
      const recovered = await facts(f);
      expect(recovered?.entry?.cliHistoryBoundary).toMatchObject({
        state: "known",
        generation: recovered?.watermark.generation,
        maxSeq: recovered?.watermark.maxSeq,
      });
      expect(recovered?.entry?.cliHistoryBoundary).not.toMatchObject({
        authFingerprint: previousBoundary.authFingerprint,
      });
      await f.run("epoch-b", async (allowed, params) => {
        expect(allowed).toBe(true);
        const prompt = await history(allowed, params);
        expect(prompt).toContain("FRESH_ACCOUNT_CANARY");
        expect(prompt).not.toContain("OLD_ACCOUNT_CANARY");
        expect(prompt).not.toContain("LEGACY_PRIVATE_TURN_");
        expect(prompt).not.toContain("OMITTED_PRIVATE_PAYLOAD_");
        expect(prompt).not.toContain("PRE_RESET_ANCHOR");
      });
      // Clearing permits a new account's fresh context, not a universal proof:
      // the old account still cannot replay the new account's retained turn.
      await f.run("epoch-a", async (allowed, params) => {
        expect(allowed).toBe(false);
        expect(await history(allowed, params)).toBeUndefined();
      });
      expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
    },
  );

  it.each(["compaction", "post-reset context"] as const)(
    "does not repair an unknown boundary across %s",
    async (kind) => {
      const { f, manager } = await unknownHistory("bytes");
      const cleared = await manager.appendResetBoundaryAsync("new");
      if (kind === "compaction") {
        // A later compaction supersedes the earlier clearing reset.
        await manager.appendCompactionAsync("UNOWNED_SUMMARY", cleared, 1000);
      } else {
        await append(manager, "UNOWNED_POST_RESET_CONTEXT");
      }
      const branch = await boundedBranch(f);
      expect(branch.findIndex((entry) => entry.id === cleared)).toBeGreaterThan(0);
      expect(buildSessionContext(branch).messages.length).toBeGreaterThan(0);
      for (const epoch of ["epoch-a", "epoch-b"]) {
        await f.run(epoch, async (allowed, params) => {
          expect(allowed).toBe(false);
          expect(await history(allowed, params)).toBeUndefined();
        });
      }
      expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
    },
  );

  it("refuses an injected reset with a dependency-pulled pre-reset row", async () => {
    const { f, manager } = await unknownHistory("bytes");
    const result = makeAgentAssistantMessage({
      provider: "openclaw",
      model: "automation-result",
      content: [{ type: "text", text: "PLACED_PRE_RESET_RESULT" }],
    });
    const pending = { ...result, excludeFromContext: true, openclawModelPlacement: "pending" };
    const source = expectDefined(await manager.appendMessageAsync(pending), "pending result");
    const reset = await manager.appendResetBoundaryAsync("new");
    const hidden = await append(manager, "UNOWNED_POST_RESET_CONTEXT");
    const tail: string[] = [];
    for (let index = 0; index < 101; index++) {
      tail.push(await manager.appendCustomEntryAsync("bookkeeping", {}));
    }
    const unplaced = await boundedBranch(f);
    expect(unplaced.map((entry) => entry.id)).toEqual([reset, ...tail.slice(-100)]);
    expect(buildSessionContext(unplaced).messages).toEqual([]);
    const placement = await manager.appendCustomEntryAsync(
      BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      {
        afterEntryId: tail.at(-1)!,
        resultEntryIds: [source],
      },
    );
    const branch = await boundedBranch(f);
    expect(branch.map((entry) => entry.id)).toEqual([source, reset, ...tail.slice(-99), placement]);
    expect(branch.some((entry) => entry.id === hidden)).toBe(false);
    // The source is not a contiguous-suffix anchor. Its placement makes context
    // nonempty, so the production planner must refuse despite boundaryIndex > 0.
    expect(buildSessionContext(branch).messages).toEqual([result]);
    await f.run("epoch-b", async (allowed, params) => {
      expect(allowed).toBe(false);
      expect(await history(allowed, params)).toBeUndefined();
    });
    expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
  });

  it("refuses a retaining reset even when its retained message is outside the byte window", async () => {
    const { f, manager } = await unknownHistory("bytes");
    const kept = await append(manager, oversized);
    const bookkeeping = await manager.appendCustomEntryAsync("retained-bookkeeping", {});
    const reset = await manager.appendResetBoundaryAsync("idle", kept);
    expect(buildSessionContext(manager.getBranch()).messages.length).toBeGreaterThan(0);
    const branch = await boundedBranch(f);
    // A pre-reset row alone is insufficient: the retained payload was omitted,
    // so the bounded projection looks empty but is not a clearing reset.
    expect(branch.map((entry) => entry.id)).toEqual([bookkeeping, reset]);
    expect(branch.at(-1)).toMatchObject({ type: "reset", firstKeptEntryId: expect.any(String) });
    expect(buildSessionContext(branch).messages).toEqual([]);
    await f.run("epoch-b", async (allowed, params) => {
      expect(allowed).toBe(false);
      expect(await history(allowed, params)).toBeUndefined();
    });
    expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
  });

  it("refuses an empty-looking reset when the byte cut omits its pre-reset anchor", async () => {
    const { f, manager } = await unknownHistory("bytes");
    // No selected row precedes this reset: its immediate predecessor alone
    // exceeds the budget. Seeing only the injected/reset row is not completeness.
    await append(manager, oversized);
    const reset = await manager.appendResetBoundaryAsync("reset");
    const branch = await boundedBranch(f);
    expect(branch.map((entry) => entry.id)).toEqual([reset]);
    expect(buildSessionContext(branch).messages).toEqual([]);
    await f.run("epoch-b", async (allowed, params) => {
      expect(allowed).toBe(false);
      expect(await history(allowed, params)).toBeUndefined();
    });
    expect((await facts(f))?.entry?.cliHistoryBoundary?.state).toBe("unknown");
  });
});
