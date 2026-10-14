import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SmokeFixture {
  run: string;
  cohort: { id: string; slug: string; name: string };
  admin: { id: string; username: string; name: string };
  sellers: Array<{ id: string; username: string; name: string; locationId: string }>;
  central: string;
  products: Record<"kinder" | "ninho", { id: string; name: string; priceCents: number }>;
  terminals: Record<"a" | "b", { id: string; code: string; label: string }>;
  purchaseOrder: { id: string; itemId: string };
}
export interface SmokeState { fixture: SmokeFixture; password: string }

/** The run's state file (the password never goes to the log; the file lives in the runner's temp directory). */
export const statePath = () => process.env.SMOKE_STATE_FILE ?? join(tmpdir(), "germinatura-smoke-state.json");
export const readState = (): SmokeState => JSON.parse(readFileSync(statePath(), "utf8")) as SmokeState;
