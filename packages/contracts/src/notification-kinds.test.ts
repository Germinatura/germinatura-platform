import { describe, expect, it } from "vitest";
import { notificationKindSchema } from "./index";

// Kinds written by public.worker_process_outbox_event; keep in sync with the worker.
const workerKinds = [
  "ACCOUNT_UPDATED", "RESERVATION_CREATED", "RESERVATION_CONVERTED", "RESERVATION_EXPIRED", "RESERVATION_READY",
  "RESERVATION_COMPLETED", "PAYMENT_CONFIRMED", "CLOSEOUT_REOPENED", "CLOSEOUT_PENDING", "RAFFLE_RESERVED",
  "RAFFLE_EXPIRED", "RAFFLE_DRAWN", "LOSS_PENDING", "COUNT_PENDING", "RETURN_PENDING", "TRANSFER_PENDING", "SALE_DIVERGENT",
  "ANNOUNCEMENT", "PRODUCT_BACK_IN_STOCK", "NEW_PRODUCT", "PROMOTION_LIVE", "RAFFLE_OPENED",
  "RAFFLE_WINNER_CONTACT", "RAFFLE_CANCELLED", "RAFFLE_REFUNDS_PENDING", "RAFFLE_REFUNDED", "EVENT_PUBLISHED", "EVENT_CANCELLED",
];

describe("notification kinds", () => {
  it("accepts every kind the outbox worker writes", () => {
    for (const kind of workerKinds) expect(notificationKindSchema.safeParse(kind).success, kind).toBe(true);
  });
});
