export function createRequestId(headers?: Headers): string {
  const supplied = headers?.get("x-request-id");
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

const sensitiveKey = /(password|senha|token|secret|authorization|cookie|api.?key|connection.?string|service.?role)/i;

function redactValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED_CONNECTION]")
      .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[REDACTED_SUPABASE_KEY]");
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactValue(nestedValue, nestedKey)]));
  }
  return value;
}

export function redactSensitiveContext(context: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(context) as Readonly<Record<string, unknown>>;
}

export function structuredLog(
  level: "info" | "warn" | "error",
  event: string,
  context: Readonly<Record<string, unknown>> = {},
): void {
  const payload = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...redactSensitiveContext(context) });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}
