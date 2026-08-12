interface QueuedItem<T> {
  readonly value: T;
  readonly critical: boolean;
  readonly bytes: number;
}

interface PendingRead<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedEventChannel<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #capacity: number;
  readonly #maxBytes: number;
  readonly #measure: (value: T) => number;
  readonly #items: QueuedItem<T>[] = [];
  readonly #readers: PendingRead<T>[] = [];
  readonly #spaceWaiters: Array<() => void> = [];
  #closed = false;
  #failure: unknown;
  #queuedBytes = 0;

  constructor(capacity = 256, options: Readonly<{ maxBytes?: number; measure?: (value: T) => number }> = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Event channel capacity must be a positive integer.");
    }
    this.#capacity = capacity;
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#measure = options.measure ?? (() => 1);
    if (!(this.#maxBytes > 0)) throw new RangeError("Event channel byte capacity must be positive.");
  }

  async push(value: T, critical: boolean): Promise<boolean> {
    const bytes = this.#valueBytes(value);
    if (bytes > this.#maxBytes) return false;
    for (;;) {
      if (this.#closed) return false;
      const reader = this.#readers.shift();
      if (reader) {
        reader.resolve({ value, done: false });
        return true;
      }
      if (this.#fits(bytes)) {
        this.#items.push({ value, critical, bytes });
        this.#queuedBytes += bytes;
        return true;
      }
      if (!critical) {
        const replaceIndex = this.#items.findIndex((item) => !item.critical);
        if (replaceIndex < 0) return false;
        const [removed] = this.#items.splice(replaceIndex, 1);
        this.#queuedBytes -= removed?.bytes ?? 0;
        if (!this.#fits(bytes)) continue;
        this.#items.push({ value, critical: false, bytes });
        this.#queuedBytes += bytes;
        return true;
      }
      await new Promise<void>((resolve) => this.#spaceWaiters.push(resolve));
    }
  }

  /** Non-blocking fan-out path. False means the consumer must recover from a cursor. */
  offer(value: T, critical: boolean, merge?: (previous: T) => T | undefined): boolean {
    if (this.#closed) return false;
    const reader = this.#readers.shift();
    if (reader) { reader.resolve({ value, done: false }); return true; }
    const bytes = this.#valueBytes(value);
    if (bytes > this.#maxBytes) return false;
    if (this.#fits(bytes)) {
      this.#items.push({ value, critical, bytes });
      this.#queuedBytes += bytes;
      return true;
    }
    if (merge) {
      for (let index = this.#items.length - 1; index >= 0; index -= 1) {
        const previous = this.#items[index];
        if (!previous || previous.critical) continue;
        const merged = merge(previous.value);
        if (merged === undefined) continue;
        const mergedBytes = this.#valueBytes(merged);
        if (mergedBytes > this.#maxBytes || this.#queuedBytes - previous.bytes + mergedBytes > this.#maxBytes) return false;
        this.#items[index] = { value: merged, critical: false, bytes: mergedBytes };
        this.#queuedBytes = this.#queuedBytes - previous.bytes + mergedBytes;
        return true;
      }
    }
    return false;
  }

  replace(value: T, critical = true): boolean {
    if (this.#closed) return false;
    this.#items.splice(0);
    this.#queuedBytes = 0;
    return this.offer(value, critical);
  }

  close(failure?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = failure;
    for (const wake of this.#spaceWaiters.splice(0)) wake();
    if (this.#items.length === 0) this.#settleReaders();
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item) {
      this.#queuedBytes -= item.bytes;
      this.#spaceWaiters.shift()?.();
      if (this.#closed && this.#items.length === 0) this.#settleReaders();
      return Promise.resolve({ value: item.value, done: false });
    }
    if (this.#closed) {
      if (this.#failure !== undefined) return Promise.reject(this.#failure);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => this.#readers.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  #settleReaders(): void {
    for (const reader of this.#readers.splice(0)) {
      if (this.#failure !== undefined) reader.reject(this.#failure);
      else reader.resolve({ value: undefined, done: true });
    }
  }

  #fits(bytes: number): boolean { return this.#items.length < this.#capacity && this.#queuedBytes + bytes <= this.#maxBytes; }
  #valueBytes(value: T): number {
    const measured = this.#measure(value);
    if (!Number.isSafeInteger(measured) || measured < 0) throw new RangeError("Event channel measurement must be a non-negative safe integer.");
    return measured;
  }
}
