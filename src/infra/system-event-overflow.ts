import { generateSecureUuid } from "./secure-random.js";
import type { SystemEvent } from "./system-events.js";

const MAX_OVERFLOW_SOURCES = 6;
export type SystemEventOverflow = {
  event: SystemEvent;
  sources: Map<string, number>;
  dropped: number;
};
type OverflowQueue = { queue: SystemEvent[]; overflow?: SystemEventOverflow };

/** Only consumption of the current summary occurrence restarts its count. */
export function queuedOverflow(entry: OverflowQueue) {
  return entry.overflow && entry.queue.includes(entry.overflow.event) ? entry.overflow : undefined;
}

/** Best-effort refusals are otherwise silent; keep one replaceable count for the next turn. */
export function recordDroppedSystemEvent(
  entry: OverflowQueue,
  source: string,
  limit: number,
  storePath?: string | null,
) {
  const previous = queuedOverflow(entry);
  const sources = new Map(previous?.sources);
  // Producer context keys are data, not authority. Keep at most six labels plus one bucket.
  const bucket = sources.has(source) || sources.size < MAX_OVERFLOW_SOURCES ? source : "other";
  sources.set(bucket, Math.min(Number.MAX_SAFE_INTEGER, (sources.get(bucket) ?? 0) + 1));
  const dropped = Math.min(Number.MAX_SAFE_INTEGER, (previous?.dropped ?? 0) + 1);
  const listed = [...sources].map(([name, n]) => `${name}: ${n}`);
  const event: SystemEvent = {
    id: generateSecureUuid(),
    text:
      `System event queue overflow: ${dropped} ${dropped === 1 ? "notice was" : "notices were"} ` +
      `dropped because ${limit} notices were already pending (${listed.join(", ")}). Dropped notices are not replayed; check their sources directly if something seems missing.`,
    // The first drop dates the gap; the count and sources carry later drops.
    ts: previous?.event.ts ?? Date.now(),
    ...(storePath === undefined ? {} : { sessionStorePath: storePath }),
    contextKey: null,
  };
  entry.queue = entry.queue.filter((queued) => queued !== previous?.event);
  entry.queue.push(event);
  entry.overflow = { event, sources, dropped };
  return dropped;
}
