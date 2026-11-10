// Cumulative per-turn budgets for the CLI streaming parser, kept beside
// `cli-output-stream.ts` so the parser stays within the file-size budget.
//
// The cumulative charges bound ordinary reply/thinking/tool-input assembly and
// tracking, with discounts for discarded payloads and bounded envelopes. They
// are not limits on raw transcript bytes or a single allocation. Once spent,
// freeze ordinary assembly and watch only for a terminal result, already-started
// tool settlement, and attributable foreground child progress. Losing the
// terminal record would turn a completed run into an unknown-outcome failure.
// The per-line `maxPendingLineChars` allocation bound is unaffected and fatal.
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type { CliToolResultDelta } from "./cli-output-contracts.js";
import { normalizeClaudeCliStreamJsonRecord } from "./cli-output-echoed-binary.js";
import {
  type ClaudeToolUseTracker,
  dispatchClaudeCliOutstandingToolSettlement,
} from "./cli-output-events.js";
import {
  decodeCliRecords,
  isClaudeSubagentRecord,
  missingMessageBoundarySeparator,
  parseClaudeCliJsonlResult,
  preferStreamedClaudeTextOverResult,
  readClaudeAttributedSubagentProgressId,
} from "./cli-output-records.js";
import {
  type CLI_STREAM_JSON_OUTPUT_LIMITS,
  streamJsonOutputLimitErrorText,
} from "./cli-output-stream-limits.js";

/**
 * Picks a terminal result's reply text from the streamed boundary state.
 *
 * On an unbudgeted turn this is the established precedence: the envelope wins
 * unless it merely restates the final streamed message, in which case the whole
 * tool-split-connected candidate wins.
 *
 * On a truncated turn the closing message was never assembled, so that
 * comparison cannot see it and the envelope would erase the reply text already
 * assembled. Text a tool split connects to the answer — a tool outstanding, or
 * a split already applied — is kept as a bounded prefix instead; a draft with
 * no tool split stays superseded exactly as on an unbudgeted turn. The in-flight
 * message is dropped when the envelope restates it, so a budget spent mid-message
 * cannot duplicate text.
 */
export function resolveCliTerminalReplyText(params: {
  assistantText: string;
  segmentStart: number;
  preserveFrom: number;
  currentMessageStart: number;
  preservedTextHasToolSplit: boolean;
  resultText: string;
  fallbackText: string;
}): string {
  const { assistantText, preserveFrom, currentMessageStart, resultText } = params;
  const preservedCandidate = assistantText.slice(preserveFrom).trim();
  const finalMessageText = assistantText.slice(currentMessageStart).trim();
  if (
    preferStreamedClaudeTextOverResult({
      streamedText: preservedCandidate,
      finalMessageText,
      resultText,
    })
  ) {
    return preservedCandidate.trim();
  }
  const truncatedPrefix =
    params.preservedTextHasToolSplit && resultText
      ? assistantText
          .slice(
            preserveFrom,
            finalMessageText && resultText.startsWith(finalMessageText)
              ? currentMessageStart
              : assistantText.length,
          )
          .trim()
      : "";
  if (truncatedPrefix) {
    const separator = missingMessageBoundarySeparator(truncatedPrefix, resultText);
    return `${truncatedPrefix}${separator}${resultText}`.trim();
  }
  // Empty terminal result can follow already-streamed text; keep that text.
  const streamedText = assistantText.slice(params.segmentStart).trim();
  return (resultText || streamedText || params.fallbackText).trim();
}

function streamJsonOutputTruncationText(kind: "raw" | "lines", limit: number): string {
  const measure = kind === "lines" ? `${limit} lines` : `${limit} characters`;
  return `CLI JSONL output exceeded ${measure}; stopped assembling output and kept watching for the terminal result.`;
}

export function createCliStreamJsonTurnBudget(limits: typeof CLI_STREAM_JSON_OUTPUT_LIMITS) {
  let spent: { kind: "raw" | "lines"; limit: number } | null = null;
  let rawChars = 0;
  let rawLines = 0;
  let observedLines = 0;
  return {
    /**
     * Every frame the parser saw, including the ones the odometers discount.
     * Output presence is a fact about the stream, not about what was charged.
     */
    observe(): void {
      observedLines += 1;
    },
    /** False once the cumulative character budget is spent. */
    chargeChars(chars: number): boolean {
      rawChars += chars;
      if (rawChars <= limits.maxTurnRawChars) {
        return true;
      }
      spent ??= { kind: "raw", limit: limits.maxTurnRawChars };
      return false;
    },
    /** False once the cumulative line budget is spent. */
    chargeLine(): boolean {
      rawLines += 1;
      if (rawLines <= limits.maxTurnLines) {
        return true;
      }
      spent ??= { kind: "lines", limit: limits.maxTurnLines };
      return false;
    },
    get exhausted(): boolean {
      return spent !== null;
    },
    get observedLines(): number {
      return observedLines;
    },
    /** A spent budget is only fatal while the turn's outcome stays unknowable. */
    errorText(terminalResultRecovered: boolean): string {
      return spent && !terminalResultRecovered
        ? streamJsonOutputLimitErrorText(spent.kind, spent.limit)
        : "";
    },
    truncationText(terminalResultRecovered: boolean): string | null {
      return spent && terminalResultRecovered
        ? streamJsonOutputTruncationText(spent.kind, spent.limit)
        : null;
    },
  };
}

/** A plugin bundle can mix a terminal result with ordinary output. Freeze
 * projection after exhaustion, admitting only the result and known settlement. */
export function createCliBudgetEventDispatcher(params: {
  toolTracker: ClaudeToolUseTracker;
  isExhausted: () => boolean;
  onEvent: (event: CliBackendParsedJsonlEvent) => void;
}) {
  return (parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[]) => {
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (
        !params.isExhausted() ||
        event.kind === "result" ||
        (event.kind === "toolResult" && params.toolTracker.startedIds.has(event.toolCallId))
      ) {
        params.onEvent(event);
      }
    }
  };
}

/**
 * Only a STRING `parent_tool_use_id` names a child record. Most Claude frames
 * carry the key with a `null` value (51 of 65 in
 * `test/fixtures/cli/claude-2.1-subagent-forwarding.jsonl`), so a bare
 * substring test would hand nearly every post-budget line to the JSON decoder
 * the prefilter exists to avoid.
 */
const ATTRIBUTED_PARENT_TOOL_USE_ID = /"parent_tool_use_id"\s*:\s*"/;

/**
 * Decodes each post-budget line only far enough to recognize the terminal
 * result and the semantic events recovery itself depends on, so a finished run
 * still reports its answer while retention stays flat.
 *
 * Stopping at the terminal result alone is not enough. While a parsed tool is
 * active, the runner routes raw stdout to the transport allowance only, so the
 * blocked-tool clock advances on two things: attributed progress for the Agent
 * call, and the tool result that settles it. Dropping both for the rest of a
 * truncated turn lets stuck-run recovery abort the very run this watcher is
 * waiting on, past the blocked-tool staleness floor.
 *
 * Settlement stays bounded — see `dispatchClaudeCliOutstandingToolSettlement`:
 * no new tool call is started or tracked here, so the tool-split state terminal
 * reply selection reads cannot move after assembly stops.
 */
export function createClaudeTerminalResultWatcher(params: {
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  toolTracker: ClaudeToolUseTracker;
  hasTerminalResult: () => boolean;
  onResultEvents: (
    parsed: CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[],
  ) => void;
  onResultRecord: (record: Record<string, unknown>) => void;
  onAttributedSubagentProgress?: (parentToolUseId: string) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onParserError: (error: unknown) => void;
}): (line: string) => void {
  return (line: string) => {
    // Native terminal/settlement records name `result`; semantic child progress
    // carries a string parent ID. Plugin parsers may use arbitrary wire keys, so
    // they still see every bounded line without projecting ordinary events.
    if (
      !line ||
      params.hasTerminalResult() ||
      (!params.parseJsonlEvent &&
        !line.includes("result") &&
        !ATTRIBUTED_PARENT_TOOL_USE_ID.test(line))
    ) {
      return;
    }
    if (params.parseJsonlEvent) {
      let parsed: ReturnType<CliBackendParseJsonlEvent>;
      try {
        parsed = params.parseJsonlEvent(line, {
          backendId: params.providerId,
          backend: params.backend,
        });
      } catch (error) {
        params.onParserError(error);
        return;
      }
      if (parsed != null) {
        params.onResultEvents(parsed);
        return;
      }
    }
    for (const record of decodeCliRecords(line)) {
      // The same parser-boundary normalization the pre-budget path applies
      // before dispatch: it strips Claude's echoed base64 in place and records
      // omitted/bytes metadata. A Read or MCP image call that starts before
      // exhaustion and returns after it settles through this path, so without
      // this its payload would reach tool events and after-tool hooks whole.
      normalizeClaudeCliStreamJsonRecord(record);
      if (record.type === "result" && record.openclaw_interim_result !== true) {
        // An attributed child result or malformed envelope cannot establish the
        // foreground turn's outcome or unlock ordinary projection again.
        if (
          !isClaudeSubagentRecord(record) &&
          parseClaudeCliJsonlResult({ ...params, parsed: record })
        ) {
          params.onResultRecord(record);
        }
        continue;
      }
      const attributedParentToolUseId = readClaudeAttributedSubagentProgressId(record);
      if (attributedParentToolUseId) {
        params.onAttributedSubagentProgress?.(attributedParentToolUseId);
        continue;
      }
      dispatchClaudeCliOutstandingToolSettlement({
        backend: params.backend,
        providerId: params.providerId,
        parsed: record,
        tracker: params.toolTracker,
        ...(params.onToolResult ? { onToolResult: params.onToolResult } : {}),
      });
    }
  };
}
