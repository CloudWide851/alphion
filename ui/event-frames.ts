import { BoundedEventChannel } from "../src/application/event-channel.js";
import type { UiEventEnvelope, UiEventFrame } from "./contracts.js";

const FRAME_CAPACITY = 256;
const FRAME_BYTES = 1024 * 1024;

export function frameEvents(events: readonly UiEventEnvelope[]): UiEventFrame | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return undefined;
  return Object.freeze({ schemaVersion: 1, cursorStart: first.cursor, cursorEnd: last.cursor, timestamp: last.timestamp, events: Object.freeze(coalesceEvents(events)) });
}

export function resyncFrame(cursor: number): UiEventFrame {
  const event: UiEventEnvelope = Object.freeze({ schemaVersion: 1, cursor, timestamp: new Date().toISOString(), payload: Object.freeze({ kind: "stream.resync-required", cursor }) });
  return frameEvents([event])!;
}

export function historyFrames(events: readonly UiEventEnvelope[]): readonly UiEventFrame[] {
  const frames: UiEventFrame[] = [];
  for (let offset = 0; offset < events.length; offset += 64) {
    const frame = frameEvents(events.slice(offset, offset + 64));
    if (frame) frames.push(frame);
  }
  return Object.freeze(frames);
}

export class UiFrameQueue implements AsyncIterableIterator<UiEventFrame> {
  readonly #channel = new BoundedEventChannel<UiEventFrame>(FRAME_CAPACITY, { maxBytes: FRAME_BYTES, measure: frameBytes });
  offer(frame: UiEventFrame): boolean { return this.#channel.offer(frame, isCritical(frame)); }
  replace(frame: UiEventFrame): void { this.#channel.replace(frame); }
  close(): void { this.#channel.close(); }
  next(): Promise<IteratorResult<UiEventFrame>> { return this.#channel.next(); }
  [Symbol.asyncIterator](): AsyncIterableIterator<UiEventFrame> { return this; }
}

function coalesceEvents(events: readonly UiEventEnvelope[]): UiEventEnvelope[] {
  const output: UiEventEnvelope[] = [];
  for (const event of events) {
    const previous = output.at(-1);
    if (previous?.payload.kind === "run.delta" && event.payload.kind === "run.delta" && previous.payload.runId === event.payload.runId) {
      output[output.length - 1] = Object.freeze({ ...event, payload: Object.freeze({ ...event.payload, delta: previous.payload.delta + event.payload.delta }) });
      continue;
    }
    if (event.payload.kind === "surface.invalidate") {
      const index = output.findIndex((item) => item.payload.kind === "surface.invalidate");
      if (index >= 0) {
        const existing = output[index]!;
        if (existing.payload.kind === "surface.invalidate") output[index] = Object.freeze({ ...event, payload: Object.freeze({ kind: "surface.invalidate", scopes: Object.freeze([...new Set([...existing.payload.scopes, ...event.payload.scopes])]), sessionIds: Object.freeze([...new Set([...existing.payload.sessionIds, ...event.payload.sessionIds])]) }) });
        continue;
      }
    }
    output.push(event);
  }
  return output;
}

function isCritical(frame: UiEventFrame): boolean { return frame.events.some((event) => event.payload.kind !== "run.delta" && event.payload.kind !== "surface.invalidate"); }
function frameBytes(frame: UiEventFrame): number { return Buffer.byteLength(JSON.stringify(frame), "utf8"); }
