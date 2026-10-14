import { expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { smokeTarget } from "./target";
import { readState } from "./state";

export const target = smokeTarget();
export const state = readState();
export const fixture = state.fixture;
export const sellerA = fixture.sellers[0];
export const sellerB = fixture.sellers[1];
export const kinder = fixture.products.kinder;
export const ninho = fixture.products.ninho;
/** A unique, non-sensitive reference of this run (never card data). */
export const reference = (tag: string) => `SMK-${fixture.run}-${tag}`.toUpperCase();
export const key = (tag: string) => `smoke-${fixture.run}-${tag}-${crypto.randomUUID()}`;

type RequestOptions = { data?: unknown; headers?: Record<string, string> };
/** API calls of a session: same cookies as its pages, with the Origin and Sec-Fetch-Site the apps require. */
export interface SessionRequest {
  get(url: string, options?: RequestOptions): ReturnType<APIRequestContext["get"]>;
  post(url: string, options?: RequestOptions): ReturnType<APIRequestContext["post"]>;
  patch(url: string, options?: RequestOptions): ReturnType<APIRequestContext["patch"]>;
}

/**
 * A real session of a synthetic person in the Portal or the PDV (its own cookies, like a browser). The pages load
 * without extra headers (a forced Origin breaks static assets); only API calls carry Origin and Sec-Fetch-Site.
 */
export async function session(browser: Browser, app: "portal" | "pdv", username: string): Promise<{ context: BrowserContext; request: SessionRequest; origin: string }> {
  const origin = app === "portal" ? target.portal : target.pdv;
  const context = await browser.newContext({ baseURL: origin });
  const withHeaders = (options: RequestOptions = {}) => ({ ...options, headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", ...options.headers } });
  const request: SessionRequest = {
    get: (url, options) => context.request.get(url, withHeaders(options)),
    post: (url, options) => context.request.post(url, withHeaders(options)),
    patch: (url, options) => context.request.patch(url, withHeaders(options)),
  };
  const login = await request.post("/api/auth/login", { data: { identifier: username, password: state.password } });
  expect(login.status(), `login ${app} de ${username}`).toBe(200);
  return { context, request, origin };
}

/** Quantity available at a location, read from the database (the stock invariant of each sale). */
export async function available(locationId: string, productId: string) {
  const [row] = await target.sql(`select available_quantity from cohort_data.inventory_balances where location_id = '${locationId}' and product_id = '${productId}'`);
  return Number(row?.available_quantity ?? 0);
}

/** Checkout of one unit at a location through the PDV, returning the sale id. */
export async function checkout(request: SessionRequest, locationId: string, productId: string, tag: string) {
  const response = await request.post("/api/v1/sales/checkout", { headers: { "Idempotency-Key": key(`checkout-${tag}`) },
    data: { channel: "PDV", locationId, items: [{ productId, quantity: 1 }] } });
  expect(response.status(), `checkout ${tag}: ${await response.text()}`).toBe(201);
  return (await response.json() as { data: { saleId: string } }).data.saleId;
}

/** Sets the acréscimo of a method in the run cohort (finance). */
export async function setRule(request: SessionRequest, method: "PIX" | "CREDITO" | "DEBITO" | "DINHEIRO", rule: { mode: "NONE" } | { mode: "PERCENTAGE"; rateBps: number } | { mode: "FIXED"; fixedCents: number }) {
  const response = await request.post("/api/v1/admin/finance/surcharges", { headers: { "Idempotency-Key": key(`rule-${method}`) },
    data: { method, reason: "Smoke automatizado do PDV", ...rule } });
  // Saving the rule already in force is refused as unchanged: the state is the one wanted either way.
  expect([200, 201, 409], `regra ${method}: ${await response.text()}`).toContain(response.status());
}

/** Confirms a Maquininha / Pix sale manually (the operator checked outside the system; nothing is charged here). */
export async function confirmManual(request: SessionRequest, saleId: string, body: Record<string, unknown>, tag: string) {
  return request.post(`/api/v1/sales/${saleId}/payments/manual-confirmation`, { headers: { "Idempotency-Key": key(`confirm-${tag}`) }, data: body });
}
