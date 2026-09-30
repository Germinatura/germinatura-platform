import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// AUD-001 (spec 5.16): read-only investigation of the audit trail.
export const auditSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

export const auditSearchQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  actor: z.string().trim().max(80).optional(),
  action: z.string().trim().max(100).regex(/^[a-z0-9_.-]*$/i).optional(),
  entityType: z.string().trim().max(64).regex(/^[a-z0-9_.-]*$/i).optional(),
  entityId: z.string().trim().max(128).optional(),
  correlationId: z.uuid().optional(),
  severity: auditSeveritySchema.optional(),
  cursorCreatedAt: z.string().optional(),
  cursorId: z.uuid().optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const auditEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  action: z.string(),
  severity: auditSeveritySchema,
  actorId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  correlationId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditSearchResponseSchema = z.object({
  data: z.array(auditEntrySchema),
  nextCursor: z.object({ createdAt: z.string(), id: z.uuid() }).strict().nullable(),
  request_id: z.string().min(1),
}).strict();

export const auditCorrelationSchema = z.object({
  correlationId: z.uuid(),
  audit: z.array(auditEntrySchema.omit({ actorId: true, correlationId: true })),
  sales: z.array(z.object({ id: z.uuid(), status: z.string(), channel: z.string(), totalCents: z.number().int(), createdAt: z.string() }).strict()),
  payments: z.array(z.object({ id: z.uuid(), saleId: z.uuid(), status: z.string(), integrationChannel: z.string().nullable(), amountCents: z.number().int(), createdAt: z.string() }).strict()),
  stockMovements: z.array(z.object({
    id: z.uuid(), movementType: z.string(), sourceType: z.string().nullable(), sourceId: z.string().nullable(), createdAt: z.string(),
    items: z.array(z.object({ productName: z.string(), quantity: z.number().int() }).strict()),
  }).strict()),
  ledger: z.array(z.object({ id: z.uuid(), entryType: z.string(), saleId: z.uuid().nullable(), amountCents: z.number().int(), createdAt: z.string() }).strict()),
  cashMovements: z.array(z.object({ id: z.uuid(), movementType: z.string(), shiftId: z.uuid(), amountCents: z.number().int(), createdAt: z.string() }).strict()),
  outbox: z.array(z.object({ topic: z.string(), status: z.string(), aggregateType: z.string(), aggregateId: z.string(), createdAt: z.string() }).strict()),
}).strict();
export type AuditCorrelation = z.infer<typeof auditCorrelationSchema>;

export const auditCorrelationResponseSchema = z.object({ data: auditCorrelationSchema, request_id: z.string().min(1) }).strict();
