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
  // ADR 0011 (PR 4): the cohort of the record; null marks a global operation. Present in the consolidated view.
  cohortId: z.uuid().nullable().optional(),
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

// AUD-001: logins, failed logins and authorization denials (no passwords, tokens or IPs).
export const securityEventKindSchema = z.enum(["LOGIN_SUCCEEDED", "LOGIN_FAILED", "LOGIN_RATE_LIMITED", "AUTHORIZATION_DENIED"]);
export type SecurityEventKind = z.infer<typeof securityEventKindSchema>;

export const securityEventsQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  kind: securityEventKindSchema.optional(),
  actor: z.string().trim().max(80).optional(),
  cursorCreatedAt: z.string().optional(),
  cursorId: z.uuid().optional(),
}).strict().refine((value) => value.from <= value.to, { message: "Período inválido", path: ["to"] });

export const securityEventSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  kind: securityEventKindSchema,
  app: z.enum(["PORTAL", "PDV"]),
  actorId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  route: z.string().nullable(),
  method: z.string().nullable(),
  requestId: z.string().nullable(),
  subjectHashPrefix: z.string().nullable(),
}).strict();
export type SecurityEvent = z.infer<typeof securityEventSchema>;

export const securityEventsResponseSchema = z.object({
  data: z.array(securityEventSchema),
  nextCursor: z.object({ createdAt: z.string(), id: z.uuid() }).strict().nullable(),
  request_id: z.string().min(1),
}).strict();

// Spec 6.1: Portal→PDV handoff. The code rides in the URL fragment so it never reaches server logs.
export const pdvHandoffResponseSchema = z.object({
  data: z.object({ url: z.string().url(), expiresAt: z.string() }).strict(),
  request_id: z.string().min(1),
}).strict();
export const pdvHandoffRedeemRequestSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
