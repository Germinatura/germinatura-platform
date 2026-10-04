import { z } from "zod";

const nullableContact = (maximum: number) => z.string().trim().min(2).max(maximum).nullable();

export const supplierSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(2).max(160),
  contactName: nullableContact(160),
  email: z.email().max(254).nullable(),
  phone: z.string().trim().min(5).max(40).nullable(),
  document: z.string().trim().min(5).max(40).nullable(),
  notes: nullableContact(1000),
  active: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const supplierQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.enum(["ALL", "ACTIVE", "INACTIVE"]).default("ALL"),
}).strict();

export const saveSupplierSchema = z.object({
  id: z.uuid().nullable(),
  expectedRevision: z.number().int().positive().nullable(),
  name: z.string().trim().min(2).max(160),
  contactName: nullableContact(160),
  email: z.email().max(254).nullable(),
  phone: z.string().trim().min(5).max(40).nullable(),
  document: z.string().trim().min(5).max(40).nullable(),
  notes: nullableContact(1000),
  active: z.boolean(),
  reason: z.string().trim().min(4).max(500),
}).strict().superRefine((value, context) => {
  if ((value.id === null) !== (value.expectedRevision === null)) {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "Supplier revision must match the operation" });
  }
  if (!value.contactName && !value.email && !value.phone) {
    context.addIssue({ code: "custom", path: ["contactName"], message: "At least one contact is required" });
  }
});

export const suppliersResponseSchema = z.object({
  data: z.array(supplierSchema),
  request_id: z.string().min(1),
}).strict();

export const saveSupplierResponseSchema = z.object({
  data: supplierSchema.extend({ correlationId: z.uuid() }),
  request_id: z.string().min(1),
}).strict();

export type Supplier = z.infer<typeof supplierSchema>;
export type SaveSupplier = z.infer<typeof saveSupplierSchema>;
