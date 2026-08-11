import type { CacheEntry, CacheStats, CacheStore } from "../../src/ports/index.js";

export class MemoryLruCache implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: Readonly<{ maxEntries?: number; maxBytes?: number }> = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  }

  get(namespace: string, key: string): Promise<CacheEntry | undefined> {
    const mapKey = `${namespace}\0${key}`;
    const entry = this.#entries.get(mapKey);
    if (!entry || Date.parse(entry.expiresAt) <= Date.now()) {
      if (entry) this.#remove(mapKey, entry);
      this.#misses += 1;
      return Promise.resolve(undefined);
    }
    this.#entries.delete(mapKey);
    this.#entries.set(mapKey, entry);
    this.#hits += 1;
    return Promise.resolve(entry);
  }

  set(entry: CacheEntry): Promise<void> {
    const mapKey = `${entry.namespace}\0${entry.key}`;
    const previous = this.#entries.get(mapKey);
    if (previous) this.#remove(mapKey, previous);
    this.#entries.set(mapKey, entry);
    this.#bytes += Buffer.byteLength(entry.value) + Buffer.byteLength(entry.provenance);
    this.#prune();
    return Promise.resolve();
  }

  delete(namespace?: string): Promise<number> {
    let deleted = 0;
    for (const [mapKey, entry] of this.#entries) {
      if (namespace === undefined || entry.namespace === namespace) {
        this.#remove(mapKey, entry);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  stats(): Promise<CacheStats> {
    return Promise.resolve({ entries: this.#entries.size, bytes: this.#bytes, hits: this.#hits, misses: this.#misses });
  }

  #prune(): void {
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.entries().next();
      if (oldest.done) return;
      const [key, entry] = oldest.value;
      this.#remove(key, entry);
    }
  }

  #remove(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#bytes -= Buffer.byteLength(entry.value) + Buffer.byteLength(entry.provenance);
  }
}
