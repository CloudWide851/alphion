interface QueuedItem<T> {
  readonly value: T;
  readonly critical: boolean;
}

interface PendingRead<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedEventChannel<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #capacity: number;
  readonly #items: QueuedItem<T>[] = [];
  readonly #readers: PendingRead<T>[] = [];
  readonly #spaceWaiters: Array<() => void> = [];
  #closed = false;
  #failure: unknown;

  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Event channel capacity must be a positive integer.");
    }
    this.#capacity = capacity;
  }

  async push(value: T, critical: boolean): Promise<boolean> {
    for (;;) {
      if (this.#closed) return false;
      const reader = this.#readers.shift();
      if (reader) {
        reader.resolve({ value, done: false });
        return true;
      }
      if (this.#items.length < this.#capacity) {
        this.#items.push({ value, critical });
        return true;
      }
      if (!critical) {
        const replaceIndex = this.#items.findIndex((item) => !item.critical);
        if (replaceIndex < 0) return false;
        this.#items.splice(replaceIndex, 1);
        this.#items.push({ value, critical: false });
        return true;
      }
      await new Promise<void>((resolve) => this.#spaceWaiters.push(resolve));
    }
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
}
