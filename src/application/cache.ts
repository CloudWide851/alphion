import type { CacheEntry, CacheStore } from "../ports/index.js";

export interface CacheLookup {
  readonly entry?: CacheEntry;
  readonly tier: "l1" | "l2" | "miss";
}

export class TieredCache {
  readonly #l1: CacheStore;
  readonly #l2: CacheStore;

  constructor(l1: CacheStore, l2: CacheStore) {
    this.#l1 = l1;
    this.#l2 = l2;
  }

  async get(namespace: string, key: string): Promise<CacheLookup> {
    const memory = await this.#l1.get(namespace, key);
    if (memory) return { entry: memory, tier: "l1" };
    const persistent = await this.#l2.get(namespace, key);
    if (!persistent) return { tier: "miss" };
    await this.#l1.set(persistent);
    return { entry: persistent, tier: "l2" };
  }

  async set(entry: CacheEntry): Promise<void> {
    await this.#l2.set(entry);
    await this.#l1.set(entry);
  }

  async delete(namespace?: string): Promise<number> {
    const deleted = await this.#l2.delete(namespace);
    await this.#l1.delete(namespace);
    return deleted;
  }
}

interface PendingFlight<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export interface FlightLease<T> {
  readonly owner: boolean;
  readonly promise: Promise<T>;
  complete(value: T): void;
  fail(reason: unknown): void;
}

export class SingleFlight<T> {
  readonly #pending = new Map<string, PendingFlight<T>>();

  acquire(key: string): FlightLease<T> {
    const existing = this.#pending.get(key);
    if (existing) {
      return {
        owner: false,
        promise: existing.promise,
        complete: () => undefined,
        fail: () => undefined,
      };
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    void promise.catch(() => undefined);
    const pending: PendingFlight<T> = { promise, resolve, reject };
    this.#pending.set(key, pending);
    let settled = false;
    return {
      owner: true,
      promise,
      complete: (value) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(key);
        resolve(value);
      },
      fail: (reason) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(key);
        reject(reason);
      },
    };
  }
}
