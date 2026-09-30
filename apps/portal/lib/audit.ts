import { auditCorrelationSchema, auditEntrySchema, securityEventSchema, type AuditCorrelation, type AuditEntry, type SecurityEvent } from "@germinatura/contracts";
import { z } from "zod";

const n = z.coerce.number();
const entry = z.object({
  id: z.uuid(), created_at: z.string(), action: z.string(), severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  actor_id: z.uuid().nullable().optional(), actor_name: z.string().nullable(), entity_type: z.string(), entity_id: z.string(),
  correlation_id: z.uuid().nullable().optional(), metadata: z.record(z.string(), z.unknown()),
});
const searchSchema = z.object({ rows: z.array(entry), next_cursor: z.object({ created_at: z.string(), id: z.uuid() }).nullable() });
const correlationSchema = z.object({
  correlation_id: z.uuid(),
  audit: z.array(entry),
  sales: z.array(z.object({ id: z.uuid(), status: z.string(), channel: z.string(), total_cents: n, created_at: z.string() })),
  payments: z.array(z.object({ id: z.uuid(), sale_id: z.uuid(), status: z.string(), integration_channel: z.string().nullable(), amount_cents: n, created_at: z.string() })),
  stock_movements: z.array(z.object({
    id: z.uuid(), movement_type: z.string(), source_type: z.string().nullable(), source_id: z.string().nullable(), created_at: z.string(),
    items: z.array(z.object({ product_name: z.string(), quantity: n })).nullable(),
  })),
  ledger: z.array(z.object({ id: z.uuid(), entry_type: z.string(), sale_id: z.uuid().nullable(), amount_cents: n, created_at: z.string() })),
  cash_movements: z.array(z.object({ id: z.uuid(), movement_type: z.string(), shift_id: z.uuid(), amount_cents: n, created_at: z.string() })),
  outbox: z.array(z.object({ topic: z.string(), status: z.string(), aggregate_type: z.string(), aggregate_id: z.string(), created_at: z.string() })),
});

function toEntry(row: z.infer<typeof entry>): AuditEntry {
  return auditEntrySchema.parse({
    id: row.id, createdAt: row.created_at, action: row.action, severity: row.severity, actorId: row.actor_id ?? null,
    actorName: row.actor_name, entityType: row.entity_type, entityId: row.entity_id, correlationId: row.correlation_id ?? null,
    metadata: row.metadata,
  });
}

/** AUD-001: maps one page of the audit search. */
export function toAuditSearch(data: unknown): { rows: AuditEntry[]; nextCursor: { createdAt: string; id: string } | null } | null {
  const parsed = searchSchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    rows: parsed.data.rows.map(toEntry),
    nextCursor: parsed.data.next_cursor && { createdAt: parsed.data.next_cursor.created_at, id: parsed.data.next_cursor.id },
  };
}

/** AUD-001: maps everything that shares one correlation. */
export function toAuditCorrelation(data: unknown): AuditCorrelation | null {
  const parsed = correlationSchema.safeParse(data);
  if (!parsed.success) return null;
  const value = parsed.data;
  return auditCorrelationSchema.parse({
    correlationId: value.correlation_id,
    audit: value.audit.map((row) => {
      const mapped = toEntry(row);
      return { id: mapped.id, createdAt: mapped.createdAt, action: mapped.action, severity: mapped.severity, actorName: mapped.actorName,
        entityType: mapped.entityType, entityId: mapped.entityId, metadata: mapped.metadata };
    }),
    sales: value.sales.map((row) => ({ id: row.id, status: row.status, channel: row.channel, totalCents: row.total_cents, createdAt: row.created_at })),
    payments: value.payments.map((row) => ({ id: row.id, saleId: row.sale_id, status: row.status, integrationChannel: row.integration_channel,
      amountCents: row.amount_cents, createdAt: row.created_at })),
    stockMovements: value.stock_movements.map((row) => ({ id: row.id, movementType: row.movement_type, sourceType: row.source_type,
      sourceId: row.source_id, createdAt: row.created_at, items: (row.items ?? []).map((item) => ({ productName: item.product_name, quantity: item.quantity })) })),
    ledger: value.ledger.map((row) => ({ id: row.id, entryType: row.entry_type, saleId: row.sale_id, amountCents: row.amount_cents, createdAt: row.created_at })),
    cashMovements: value.cash_movements.map((row) => ({ id: row.id, movementType: row.movement_type, shiftId: row.shift_id,
      amountCents: row.amount_cents, createdAt: row.created_at })),
    outbox: value.outbox.map((row) => ({ topic: row.topic, status: row.status, aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id, createdAt: row.created_at })),
  });
}

const securitySchema = z.object({
  rows: z.array(z.object({
    id: z.uuid(), created_at: z.string(), kind: z.enum(["LOGIN_SUCCEEDED", "LOGIN_FAILED", "LOGIN_RATE_LIMITED", "AUTHORIZATION_DENIED"]),
    app: z.enum(["PORTAL", "PDV"]), actor_id: z.uuid().nullable(), actor_name: z.string().nullable(), route: z.string().nullable(),
    method: z.string().nullable(), request_id: z.string().nullable(), subject_hash_prefix: z.string().nullable(),
  })),
  next_cursor: z.object({ created_at: z.string(), id: z.uuid() }).nullable(),
});

/** AUD-001: maps one page of security events. */
export function toSecurityEvents(data: unknown): { rows: SecurityEvent[]; nextCursor: { createdAt: string; id: string } | null } | null {
  const parsed = securitySchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    rows: parsed.data.rows.map((row) => securityEventSchema.parse({
      id: row.id, createdAt: row.created_at, kind: row.kind, app: row.app, actorId: row.actor_id, actorName: row.actor_name,
      route: row.route, method: row.method, requestId: row.request_id, subjectHashPrefix: row.subject_hash_prefix,
    })),
    nextCursor: parsed.data.next_cursor && { createdAt: parsed.data.next_cursor.created_at, id: parsed.data.next_cursor.id },
  };
}
