export function createRequestId(headers?: Headers): string {
  return headers?.get("x-request-id") ?? crypto.randomUUID();
}

export function structuredLog(
  level: "info" | "warn" | "error",
  event: string,
  context: Readonly<Record<string, unknown>> = {},
): void {
  const payload = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...context });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}
