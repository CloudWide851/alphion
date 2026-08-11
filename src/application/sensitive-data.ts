const SENSITIVE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/giu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b\s*[:=]\s*["']?[^\s"',;]{8,}/giu,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/gu,
] as const;

export function containsPotentialSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return SENSITIVE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }
  if (Array.isArray(value)) return value.some(containsPotentialSecret);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsPotentialSecret);
}

export function redactPotentialSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export function sanitizeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return sanitizeValue(value) as Readonly<Record<string, unknown>>;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactPotentialSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]));
}
