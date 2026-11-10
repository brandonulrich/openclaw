import { describe, expect, it, vi } from "vitest";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { claudeTextDelta, createClaudeParser } from "./cli-output.test-helpers.js";

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const tool = (id: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Agent", input: {} }] },
});
const terminal = { type: "result", subtype: "success", result: "answer", session_id: "recovered" };
function exhaustLines(parser: ReturnType<typeof createClaudeParser>) {
  parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1));
  expect(parser.getFatalErrorText()).toBeNull();
  expect(parser.getErrorText()).toContain("exceeded 20000 lines");
}

describe("Claude cumulative budget recovery", () => {
  it.each([false, true])(
    "keeps bounded text without resurrecting a draft (tool split: %s)",
    (split) => {
      const onAssistantDelta = vi.fn();
      const onThinkingDelta = vi.fn();
      const onToolUseStart = vi.fn();
      const onToolInputDelta = vi.fn();
      const onToolResult = vi.fn();
      const parser = createClaudeParser({
        onAssistantDelta,
        onThinkingDelta,
        onToolUseStart,
        onToolInputDelta,
        onToolResult,
      });
      parser.push(line(claudeTextDelta("Before.")));
      if (split) {
        parser.push(line(tool("agent")));
      }
      exhaustLines(parser);
      const pendingOutput = parser.getOutput();
      // These would grow text, thinking, pending input and tracked IDs on the
      // ordinary path. No terminal envelope can hide growth in emitted snapshots.
      for (let index = 0; index < 300; index += 1) {
        parser.push(line(claudeTextDelta("late text".repeat(1024))));
        parser.push(
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 9,
              delta: { type: "thinking_delta", thinking: "late thinking" },
            },
          }),
        );
        parser.push(line(tool(`late-${index}`)));
        parser.push(
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: `pending-${index}`, name: "Bash", input: {} },
            },
          }),
        );
        parser.push(
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: "x".repeat(1024) },
            },
          }),
        );
        parser.push(
          line({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: `never-started-${index}`, content: "ignored" },
              ],
            },
          }),
        );
      }
      expect(parser.getOutput()).toEqual(pendingOutput);
      expect(onAssistantDelta).toHaveBeenCalledTimes(1);
      expect(onAssistantDelta.mock.calls[0]?.[0].text).toBe("Before.");
      expect(onThinkingDelta).not.toHaveBeenCalled();
      expect(onToolInputDelta).not.toHaveBeenCalled();
      expect(onToolUseStart).toHaveBeenCalledTimes(split ? 1 : 0);
      expect(onToolResult).not.toHaveBeenCalled();
      parser.push(line(terminal));
      parser.push(line({ ...terminal, result: "duplicate terminal must not replace answer" }));
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()).toMatchObject({
        text: split ? "Before.\n\nanswer" : "answer",
        ...(split ? { rawFinalText: "answer" } : {}),
        sessionId: "recovered",
      });
      expect(parser.getOutputTruncationText()).toContain("stopped assembling output");
      // A terminal result is not permission to invent settlement for an outstanding call.
      expect(onToolResult).not.toHaveBeenCalled();
    },
  );

  it("normalizes echoed binary and settles a previously started call only once", () => {
    const onToolResult = vi.fn();
    const parser = createClaudeParser({ onToolResult });
    parser.push(line(tool("image")));
    exhaustLines(parser);
    const result = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "image",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
            ],
          },
        ],
      },
    };
    parser.push(line(result) + line(result));
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: "image",
      result: [{ type: "image", omitted: true, bytes: 1 }],
    });
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain("YQ==");
  });

  it.each(["lines", "chars"] as const)(
    "recovers a terminal record that itself crosses %s",
    (kind) => {
      const parser = createClaudeParser();
      if (kind === "lines") {
        parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines));
      } else {
        const padding = line({ type: "system", padding: "x".repeat(65536) });
        const count = Math.floor(
          (CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars - 1) / padding.length,
        );
        parser.push(padding.repeat(count));
        parser.push(
          " ".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars - count * padding.length - 2) +
            "\n",
        );
      }
      expect(parser.getErrorText()).toBeNull();
      parser.push(line(terminal));
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()).toMatchObject({ text: "answer", sessionId: "recovered" });
      expect(parser.getOutputTruncationText()).not.toBeNull();
    },
  );

  it("recovers custom terminal bundles but freezes new starts and text", () => {
    const onToolUseStart = vi.fn();
    const onToolResult = vi.fn();
    const onAssistantDelta = vi.fn();
    const parser = createClaudeParser({
      onToolUseStart,
      onToolResult,
      onAssistantDelta,
      parseJsonlEvent: (raw) => {
        const record = JSON.parse(raw);
        if (record.done) {
          return [
            { kind: "text", text: "not assembled" },
            { kind: "toolStart", toolCallId: "new", name: "Bash" },
            { kind: "toolResult", toolCallId: "never-started", result: "ignored" },
            { kind: "toolResult", toolCallId: "agent", result: "settled" },
            { kind: "toolResult", toolCallId: "agent", result: "duplicate" },
            {
              kind: "result",
              text: "custom answer",
              sessionId: "custom-session",
              usage: { input: 11, output: 7 },
            },
          ];
        }
        return null;
      },
    });
    parser.push(line(tool("agent")));
    exhaustLines(parser);
    parser.push(line({ done: true }));
    parser.finish();
    expect(parser.getOutput()).toMatchObject({
      text: "custom answer",
      sessionId: "custom-session",
      usage: { input: 11, output: 7 },
    });
    expect(onAssistantDelta).not.toHaveBeenCalled();
    expect(onToolUseStart).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: "agent",
      result: "settled",
    });
  });

  it("keeps lifecycle parser failures fatal after exhaustion without parsing blank frames", () => {
    const lifecycle = vi.fn((raw: string) => {
      if (raw === "bad lifecycle") {
        throw new Error("fixture lifecycle failure");
      }
      return null;
    });
    const parser = createClaudeParser({ parseJsonlLifecycleEvent: lifecycle });
    exhaustLines(parser);
    expect(lifecycle).not.toHaveBeenCalled();
    parser.push("bad lifecycle\n");
    parser.push(line(terminal));
    expect(parser.getFatalErrorText()).toBe(
      "CLI backend claude-cli JSONL lifecycle parser failed: fixture lifecycle failure",
    );
    expect(parser.getOutput()?.errorText).toBe(parser.getFatalErrorText());
  });

  it("keeps a plugin parser failure fatal after exhaustion", () => {
    const parser = createClaudeParser({
      parseJsonlEvent: () => {
        throw new Error("fixture malformed");
      },
    });
    exhaustLines(parser);
    parser.push(line({ malformed: true }));
    parser.push(line(terminal));
    parser.finish();
    expect(parser.getFatalErrorText()).toContain("JSONL parser failed: fixture malformed");
    expect(parser.getOutput()?.errorText).toBe(parser.getFatalErrorText());
  });

  it("does not recover from a malformed or child-only terminal envelope", () => {
    const parser = createClaudeParser();
    exhaustLines(parser);
    parser.push(line({ type: "result", subtype: "success", item: { text: "not a result" } }));
    parser.push(line({ ...terminal, parent_tool_use_id: "child-parent" }));
    parser.finish();
    expect(parser.hasTerminalResult()).toBe(false);
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
    expect(parser.getOutput()?.text).toBe("");
  });

  it("preserves a recovered terminal failure instead of treating it as success", () => {
    const parser = createClaudeParser();
    exhaustLines(parser);
    parser.push(
      line({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["max turns reached"],
      }),
    );
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).toMatchObject({ terminalFailure: { reason: "max_turns" } });
  });
});
