import { createHash, randomUUID } from "node:crypto";

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles.");
    seen.add(value);
    const result = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles.");
    seen.add(value);
    const source = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) result[key] = normalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet<object>()));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
