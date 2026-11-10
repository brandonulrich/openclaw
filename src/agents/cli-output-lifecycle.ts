import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendConfig,
  CliBackendParseJsonlLifecycleEvent,
  CliBackendParsedJsonlLifecycleEvent,
} from "../plugins/cli-backend.types.js";
import type { CliCompactionDelta, CliJsonlStreamingParserOptions } from "./cli-output-contracts.js";
import { decodeCliRecords } from "./cli-output-records.js";

function parseCliBackendLifecycleLine(params: {
  line: string;
  backendId: string;
  backend: CliBackendConfig;
  parse?: CliBackendParseJsonlLifecycleEvent;
}): { events: readonly CliBackendParsedJsonlLifecycleEvent[] } | { errorText: string } | undefined {
  if (!params.parse) {
    return undefined;
  }
  try {
    const parsed = params.parse(params.line, {
      backendId: params.backendId,
      backend: params.backend,
    });
    if (parsed == null) {
      return undefined;
    }
    return { events: "kind" in parsed ? [parsed] : parsed };
  } catch (error) {
    return {
      errorText: truncateUtf16Safe(
        `CLI backend ${params.backendId} JSONL lifecycle parser failed: ${formatErrorMessage(error)}`,
        500,
      ),
    };
  }
}

function projectCliBackendLifecycleEvent(
  event: CliBackendParsedJsonlLifecycleEvent,
): CliCompactionDelta {
  return event.phase === "start"
    ? { phase: "start" }
    : { phase: "end", completed: event.completed };
}

/** Lifecycle transitions carry bounded control state, not ordinary reply assembly.
 * They must still close (or begin) compaction after a cumulative budget is spent. */
export function createCliBackendLifecycleLineHandler(
  params: Pick<
    CliJsonlStreamingParserOptions,
    "backend" | "providerId" | "parseJsonlLifecycleEvent" | "onCompaction"
  > & {
    accountLine: (chars: number) => void;
    onRecord: (record: Record<string, unknown>) => void;
    onErrorText: (errorText: string) => void;
  },
) {
  return (line: string, rawLine: string): boolean => {
    if (!line) {
      return false;
    }
    const lifecycle = parseCliBackendLifecycleLine({
      line,
      backendId: params.providerId,
      backend: params.backend,
      parse: params.parseJsonlLifecycleEvent,
    });
    if (!lifecycle) {
      return false;
    }
    if ("errorText" in lifecycle) {
      params.onErrorText(lifecycle.errorText);
    } else {
      params.accountLine(rawLine.length);
      for (const record of decodeCliRecords(line)) {
        params.onRecord(record);
      }
      for (const event of lifecycle.events) {
        params.onCompaction?.(projectCliBackendLifecycleEvent(event));
      }
    }
    return true;
  };
}
