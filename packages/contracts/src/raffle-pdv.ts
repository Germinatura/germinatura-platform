import { z } from "zod";

// Spec 6.15 (RAF-004): raffle numbers sold at the PDV; the buyer is a registered account or a name and one contact.
export const pdvRaffleSchema = z.object({
  campaignId: z.uuid(), name: z.string(), productName: z.string(), numberCount: z.number().int().positive(),
  endsAt: z.string(), unitPriceCents: z.number().int().nullable(), availableCount: z.number().int(),
}).strict();
export type PdvRaffle = z.infer<typeof pdvRaffleSchema>;
export const pdvRafflesResponseSchema = z.object({ data: z.array(pdvRaffleSchema), request_id: z.string().min(1) }).strict();

export const raffleBuyerLookupResponseSchema = z.object({
  data: z.object({ profileId: z.uuid(), displayName: z.string() }).strict().nullable(),
  request_id: z.string().min(1),
}).strict();

export const pdvRaffleReservationRequestSchema = z.object({
  locationId: z.uuid(),
  numbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
  buyer: z.union([
    z.object({ profileId: z.uuid() }).strict(),
    z.object({ name: z.string().trim().min(2).max(120), contact: z.string().trim().min(8).max(120) }).strict(),
  ]),
}).strict().refine((value) => new Set(value.numbers).size === value.numbers.length, { path: ["numbers"], message: "Raffle numbers must be unique" });
export type PdvRaffleReservationRequest = z.infer<typeof pdvRaffleReservationRequestSchema>;

export const raffleNumberBoardResponseSchema = z.object({
  data: z.array(z.object({ number: z.number().int().positive(), state: z.enum(["AVAILABLE", "TAKEN", "MINE"]) }).strict()),
  request_id: z.string().min(1),
}).strict();
