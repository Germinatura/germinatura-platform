import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ADMIN-002 (spec 4.1, 5.1 e 5.17): progress is the net available for the graduation — real accounts (PicPay free balance,
// Cofrinho, physical cash) minus open payables (decision of 12/10/2026). Receivables are future value, shown apart;
// countingFrom drives the projection and the "resultado operacional desde" indicator, never the progress.
export const fundraisingGoalSchema = z.object({
  countingFrom: isoDate,
  targetDate: isoDate,
  publicVisible: z.boolean().optional(),
  showAmounts: z.boolean(),
  targetCents: z.number().int().nullable(),
  currentCents: z.number().int().nullable(),
  projectedCents: z.number().int().nullable(),
  progressBps: z.number().int().nonnegative(),
  projectedBps: z.number().int().nonnegative(),
  onTrack: z.boolean(),
  daysRemaining: z.number().int().nonnegative(),
  updatedAt: z.string().nullable().optional(),
  basis: z.literal("NET_AVAILABLE").optional(),
  accumulatedCents: z.number().int().nullable().optional(),
  committedCents: z.number().int().nullable().optional(),
  receivablesCents: z.number().int().nullable().optional(),
  accounts: z.object({ freeCents: z.number().int(), vaultCents: z.number().int(), cashCents: z.number().int() }).strict().nullable().optional(),
  operatingResultSinceCents: z.number().int().nullable().optional(),
}).strict();
export type FundraisingGoal = z.infer<typeof fundraisingGoalSchema>;

export const fundraisingGoalRequestSchema = z.object({
  targetCents: z.number().int().min(100).max(99_999_999_999),
  countingFrom: isoDate,
  targetDate: isoDate,
  publicVisible: z.boolean(),
  showAmounts: z.boolean(),
}).strict().refine((value) => value.targetDate >= value.countingFrom, { message: "A data-alvo precisa ser depois do início", path: ["targetDate"] });
export type FundraisingGoalRequest = z.infer<typeof fundraisingGoalRequestSchema>;

export const fundraisingGoalResponseSchema = z.object({ data: fundraisingGoalSchema.nullable(), request_id: z.string().min(1) }).strict();
