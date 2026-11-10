/**
 * Bounded-retention experiment, complementary to the real subprocess tests.
 * Real parser; synthetic frames only. No model, subprocess, or live state.
 * Run: node --expose-gc --import ./scripts/tsx.mjs scripts/proof-cli-stream-turn-budget.ts
 * GC deltas are environment-specific evidence, not a portable CI heap contract.
 */
import assert from "node:assert/strict";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";

const gc = globalThis.gc;
assert(gc, "Run with --expose-gc");
let textEvents = 0;
let toolStarts = 0;
const parser = createCliJsonlStreamingParser({
  backend: { command: "fixture", output: "jsonl", jsonlDialect: "claude-stream-json" },
  providerId: "claude-cli",
  onAssistantDelta: () => {
    textEvents += 1;
  },
  onToolUseStart: () => {
    toolStarts += 1;
  },
});
const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
push({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before." } },
});
push({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "agent", name: "Agent", input: {} }] },
});
parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1));
assert.equal(parser.getFatalErrorText(), null);
assert.match(parser.getErrorText() ?? "", /exceeded 20000 lines/);
const pendingOutput = parser.getOutput();
const expectedTextEvents = textEvents;
const expectedToolStarts = toolStarts;
let streamed = 0;
function batch() {
  const start = streamed;
  for (let index = 0; streamed - start < 32 * 1024 * 1024; index += 1) {
    const text = `late-${streamed}-${index} ` + "x".repeat(65536);
    const chunk =
      [
        {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: `late-${streamed}`, name: "Agent", input: { text } }],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: `late-${streamed}`, content: text }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    streamed += Buffer.byteLength(chunk);
    parser.push(chunk);
  }
}
// Warm the watcher/JIT before measuring retained, rather than transient, memory.
batch();
gc();
const baseline = process.memoryUsage().heapUsed;
const retained: number[] = [];
for (let pass = 0; pass < 4; pass += 1) {
  batch();
  gc();
  retained.push(process.memoryUsage().heapUsed - baseline);
  assert.deepEqual(parser.getOutput(), pendingOutput);
  assert.equal(textEvents, expectedTextEvents);
  assert.equal(toolStarts, expectedToolStarts);
}
assert(Math.max(...retained) < 2 * 1024 * 1024, `retained heap grew: ${JSON.stringify(retained)}`);
push({ type: "result", subtype: "success", session_id: "retention-session", result: "answer" });
parser.finish();
assert.equal(parser.getErrorText(), null);
assert.equal(parser.getOutput()?.text, "Before.\n\nanswer");
assert.equal(parser.getOutput()?.rawFinalText, "answer");
console.log(
  JSON.stringify({
    streamedPostBudgetBytes: streamed,
    retainedHeapGrowthBytes: retained,
    newTextEvents: textEvents - expectedTextEvents,
    newToolStarts: toolStarts - expectedToolStarts,
    recoveredText: parser.getOutput()?.text,
  }),
);
