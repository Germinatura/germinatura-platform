import { randomUUID } from "node:crypto";
import { Metrics, trend } from "./lib/metrics.mjs";
import { sleep, think, VirtualUser } from "./lib/client.mjs";

const contended = [409, 422];

// One session per user for the whole run (as a browser keeps it). Logins go through a single queue spaced by
// LOGIN_SPACING_MS and retry with backoff, so the run measures how fast accounts can sign in instead of
// aborting; every attempt is kept in loginLog, and the first refusal is diagnosed against Supabase Auth.
const sessions = new Map();
const LOGIN_SPACING_MS = 1000;
let loginQueue = Promise.resolve();
export const loginLog = { attempts: [], diagnostics: [] };

async function signIn(user, username, password, diagnose) {
  for (let attempt = 1; ; attempt += 1) {
    const turn = loginQueue.then(() => sleep(LOGIN_SPACING_MS));
    loginQueue = turn;
    await turn;
    const started = Date.now();
    const result = await user.request("auth.login", "POST", "/api/auth/login", { body: { identifier: username, password } });
    loginLog.attempts.push({ at: new Date(started).toISOString(), origin: user.origin, attempt, status: result.status, code: result.body?.code ?? null });
    if (result.status === 200) return;
    if (loginLog.diagnostics.length < 3 && diagnose) loginLog.diagnostics.push({ at: new Date().toISOString(), portal: { status: result.status, code: result.body?.code ?? null }, auth: await diagnose(username) });
    if (attempt >= 8) throw new Error(`Login de carga recusado após ${attempt} tentativas (${result.status}).`);
    await sleep(Math.min(60000, 5000 * 2 ** (attempt - 1)));
  }
}

async function loggedIn(origin, metrics, username, password, diagnose) {
  const key = `${origin}|${username}`;
  let user = sessions.get(key);
  if (!user) {
    user = new VirtualUser(origin, null);
    await signIn(user, username, password, diagnose);
    sessions.set(key, user);
  }
  user.metrics = metrics;
  return user;
}

async function untilDeadline(deadline, body) {
  while (Date.now() < deadline) await body();
}

// A — consumers browsing: Início, catalog pages, events, promotions (quote), raffles and notifications.
export async function browsing(context) {
  const { target, fixtures, password, users = 50, minutes = 10 } = context;
  const metrics = new Metrics("A — navegação e leitura");
  const consumers = fixtures.consumers.slice(0, users);
  const coupon = fixtures.products.coupon;
  const sessionsReady = await Promise.all(consumers.map((consumer) => loggedIn(target.portal, metrics, consumer.username, password, context.diagnose)));
  const deadline = Date.now() + minutes * 60000;
  metrics.started = Date.now();
  await Promise.all(sessionsReady.map(async (user, index) => {
    await think(0, Math.min(10000, index * 200));
    await untilDeadline(deadline, async () => {
      await user.request("page /inicio", "GET", "/inicio");
      await user.request("api showcase", "GET", "/api/v1/showcase");
      await think(1000, 3000);
      await user.request("page /catalogo", "GET", "/catalogo");
      const first = await user.request("api catalog p1", "GET", "/api/v1/catalog/products?limit=24");
      if (first.body?.nextCursor) await user.request("api catalog p2", "GET", `/api/v1/catalog/products?limit=24&cursor=${first.body.nextCursor}`);
      await user.request("api pricing quote", "POST", "/api/v1/pricing/quote", { body: { channel: "PORTAL", items: [{ productId: coupon, quantity: 2 }] } });
      await think(1000, 3000);
      await user.request("api events", "GET", "/api/v1/events");
      await user.request("page /eventos", "GET", "/eventos");
      await user.request("page /rifas", "GET", "/rifas");
      await user.request("api notifications", "GET", "/api/v1/notifications?limit=5");
      await think(1000, 3000);
    });
  }));
  return metrics.finish().summary();
}

// B — sellers operating the PDV (through the PDV host and its service binding): catalog, own stock, history,
// pickups, raffles, shift and terminals. No external payment confirmation is simulated here.
export async function operating(context) {
  const { target, fixtures, password, users = 15, minutes = 10 } = context;
  const metrics = new Metrics("B — operação autenticada do PDV");
  const sellersReady = await Promise.all(fixtures.sellers.slice(0, users).map((seller) => loggedIn(target.pdv, metrics, seller.username, password, context.diagnose)));
  const deadline = Date.now() + minutes * 60000;
  metrics.started = Date.now();
  await Promise.all(sellersReady.map(async (user, index) => {
    await think(0, index * 300);
    await untilDeadline(deadline, async () => {
      await user.request("pdv page /", "GET", "/");
      await user.request("pdv catalog", "GET", "/api/v1/catalog/products?limit=50");
      await user.request("pdv own stock (returns)", "GET", "/api/v1/inventory/returns");
      await user.request("pdv transfer sources", "GET", "/api/v1/inventory/transfer-requests?limit=20");
      await think(1500, 4000);
      await user.request("pdv my sales", "GET", "/api/v1/pdv/sales");
      await user.request("pdv my sales pending", "GET", "/api/v1/pdv/sales?filter=PENDING");
      await user.request("pdv pickups", "GET", "/api/v1/pdv/pickups");
      await user.request("pdv raffles", "GET", "/api/v1/pdv/raffles");
      await user.request("pdv shift", "GET", "/api/v1/pdv/shifts");
      await user.request("pdv terminals", "GET", "/api/v1/pdv/terminals");
      await think(1500, 4000);
    });
  }));
  return metrics.finish().summary();
}

// C — controlled contention on the run's own products. Each case reports what won and the invariants after it.
export async function contention(context) {
  const { target, fixtures, password, sql, run } = context;
  const metrics = new Metrics("C — concorrência transacional");
  const cases = [];
  const check = async () => (await sql(`select check_name, violations from loadtest.check('${run}')`)).map((row) => ({ check: row.check_name, violations: Number(row.violations) }));
  const consumers = await Promise.all(fixtures.consumers.slice(0, 20).map((consumer) => loggedIn(target.portal, metrics, consumer.username, password, context.diagnose)));
  const [s1, s2, s3] = fixtures.sellers;
  const seller1 = await loggedIn(target.pdv, metrics, s1.username, password, context.diagnose);
  const seller2 = await loggedIn(target.pdv, metrics, s2.username, password, context.diagnose);
  const seller3 = await loggedIn(target.pdv, metrics, s3.username, password, context.diagnose);
  const admin = await loggedIn(target.pdv, metrics, fixtures.admin.username, password, context.diagnose);
  const key = (tag) => `load-${run}-${tag}-${randomUUID()}`;
  const record = async (name, expectation, results, winners, extra = {}) => {
    cases.push({ name, expectation, attempts: results.length, successes: winners, statuses: tally(results), ...extra, invariants: await check() });
  };

  // 1. Twenty consumers race for the last central unit.
  const lastUnit = await Promise.all(consumers.map((user) => user.request("C1 reserve last unit", "POST", "/api/v1/reservations",
    { body: { items: [{ productId: fixtures.products.last_unit, quantity: 1 }] }, headers: { "Idempotency-Key": key("last") }, expected: contended })));
  await record("20 clientes pela última unidade", "exatamente 1 reserva", lastUnit, lastUnit.filter((result) => result.status < 300).length);

  // 2. Sale versus transfer of the same seller unit: seller 2 asks, then seller 1 accepts while selling it.
  const asked = await seller2.request("C2 request transfer", "POST", "/api/v1/inventory/transfer-requests",
    { body: { fromLocationId: s1.locationId, productId: fixtures.products.sale_transfer, quantity: 1, reason: "Teste de concorrência" }, headers: { "Idempotency-Key": key("transfer") } });
  const transferId = asked.body?.data?.id ?? asked.body?.data?.requestId;
  const saleVsTransfer = await Promise.all([
    seller1.request("C2 checkout contested unit", "POST", "/api/v1/sales/checkout",
      { body: { channel: "PDV", locationId: s1.locationId, items: [{ productId: fixtures.products.sale_transfer, quantity: 1 }] }, headers: { "Idempotency-Key": key("sale") }, expected: contended }),
    transferId ? seller1.request("C2 accept transfer", "PATCH", `/api/v1/inventory/transfer-requests/${transferId}`,
      { body: { action: "ACCEPT", reason: "Teste de concorrência" }, headers: { "Idempotency-Key": key("accept") }, expected: contended }) : Promise.resolve({ status: 0 }),
  ]);
  await record("venda × transferência da mesma unidade", "exatamente 1 vence", saleVsTransfer, saleVsTransfer.filter((result) => result.status < 300).length, { transferRequested: Boolean(transferId) });

  // 3. Reservation versus central sale of the same unit.
  const reserveVsSale = await Promise.all([
    consumers[0].request("C3 reserve contested", "POST", "/api/v1/reservations",
      { body: { items: [{ productId: fixtures.products.reserve_sale, quantity: 1 }] }, headers: { "Idempotency-Key": key("rs-reserve") }, expected: contended }),
    admin.request("C3 central checkout contested", "POST", "/api/v1/sales/checkout",
      { body: { channel: "PDV", locationId: fixtures.central, items: [{ productId: fixtures.products.reserve_sale, quantity: 1 }] }, headers: { "Idempotency-Key": key("rs-sale") }, expected: contended }),
  ]);
  await record("reserva × venda da mesma unidade", "exatamente 1 vence", reserveVsSale, reserveVsSale.filter((result) => result.status < 300).length);

  // 4. Twenty consumers race for the same raffle numbers.
  const raffle = await Promise.all(consumers.map((user) => user.request("C4 reserve raffle numbers", "POST", `/api/v1/raffles/${fixtures.raffle}/numbers/reserve`,
    { body: { numbers: [7, 8] }, headers: { "Idempotency-Key": key("raffle") }, expected: contended })));
  await record("20 clientes pelos mesmos números de rifa", "exatamente 1 dono", raffle, raffle.filter((result) => result.status < 300).length);

  // 5. Checkout replayed ten times at once with the same idempotency key.
  const replayKey = key("replay");
  const replay = await Promise.all(Array.from({ length: 10 }, () => seller3.request("C5 checkout replay", "POST", "/api/v1/sales/checkout",
    { body: { channel: "PDV", locationId: s3.locationId, items: [{ productId: fixtures.products.volume_a, quantity: 1 }] }, headers: { "Idempotency-Key": replayKey }, expected: contended })));
  const saleIds = new Set(replay.map((result) => result.body?.data?.saleId).filter(Boolean));
  await record("replay do checkout com a mesma chave", "uma única venda", replay, saleIds.size, { distinctSales: saleIds.size });

  // 6. Two simultaneous confirmations of the same sale (different keys).
  const [saleId] = [...saleIds];
  const confirmations = saleId ? await Promise.all(["one", "two"].map((tag) => seller3.request("C6 double confirmation", "POST", `/api/v1/sales/${saleId}/payments/manual-confirmation`,
    { body: { integrationChannel: "PIX_AREA", proofReference: `CARGA-${run}-${tag}`.toUpperCase() }, headers: { "Idempotency-Key": key(`confirm-${tag}`) }, expected: contended }))) : [];
  await record("duas confirmações simultâneas", "exatamente 1 pagamento", confirmations, confirmations.filter((result) => result.status < 300).length);

  // 7. Coupon with a global limit of 5, fifteen reservations at once.
  const coupon = await Promise.all(consumers.slice(0, 15).map((user) => user.request("C7 coupon at the limit", "POST", "/api/v1/reservations",
    { body: { couponCode: fixtures.coupon, items: [{ productId: fixtures.products.coupon, quantity: 1 }] }, headers: { "Idempotency-Key": key("coupon") }, expected: contended })));
  // PROMO-007: past the limit the coupon simply stops applying; reservations still go through at full price.
  const [redemptions] = await sql(`select count(*)::int as total from public.promotion_redemptions redemption join public.promotions promotion on promotion.id = redemption.promotion_id where promotion.code = '${fixtures.coupon}' and redemption.status in ('RESERVED', 'CONSUMED')`);
  const discounted = coupon.filter((result) => result.status < 300 && Number(result.body?.data?.quote?.discountTotal?.amountCents ?? result.body?.data?.quote?.discountTotalCents ?? 0) > 0).length;
  await record("cupom no limite global (5)", "no máximo 5 com desconto", coupon, discounted, { reservations: coupon.filter((result) => result.status < 300).length, redemptions: redemptions?.total ?? null });

  return { ...metrics.finish().summary(), cases };
}

// D — moderate soak: readers plus a steady trickle of real sales (checkout + Área Pix) and reservation cycles.
export async function soak(context) {
  const { target, fixtures, password, sql, run, minutes = 30, readers = 20, sellers = 5 } = context;
  const metrics = new Metrics("D — soak");
  const readerSessions = await Promise.all(fixtures.consumers.slice(20, 20 + readers).map((consumer) => loggedIn(target.portal, metrics, consumer.username, password, context.diagnose)));
  const sellerSessions = await Promise.all(fixtures.sellers.slice(5, 5 + sellers).map((seller) => loggedIn(target.pdv, metrics, seller.username, password, context.diagnose)));
  const deadline = Date.now() + minutes * 60000;
  metrics.started = Date.now();
  const samples = [];
  const sampler = (async () => {
    while (Date.now() < deadline) {
      const [row] = await sql(`select count(*) filter (where status = 'PENDING')::int as pending, count(*) filter (where status = 'PROCESSING')::int as processing, count(*) filter (where status = 'FAILED')::int as failed, coalesce(extract(epoch from now() - min(created_at) filter (where status = 'PENDING')), 0)::int as oldest_pending_seconds,
        (select count(*) from pg_stat_activity where datname = current_database() and state = 'active')::int as db_active,
        (select count(*) from pg_stat_activity where datname = current_database())::int as db_connections,
        (select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock')::int as db_lock_waits,
        (select coalesce(max(extract(epoch from now() - query_start)), 0)::int from pg_stat_activity where datname = current_database() and state = 'active' and pid <> pg_backend_pid()) as db_longest_active_seconds
        from public.outbox_events`)
        .catch(() => [null]);
      samples.push({ minute: Math.floor((Date.now() - metrics.started) / 60000), ...(row ?? { error: true }) });
      await think(60000, 60000);
    }
  })();
  const reading = Promise.all(readerSessions.map(async (user, index) => {
    await think(0, index * 300);
    let cycle = 0;
    await untilDeadline(deadline, async () => {
      cycle += 1;
      await user.request("soak showcase", "GET", "/api/v1/showcase");
      await user.request("soak catalog", "GET", "/api/v1/catalog/products?limit=24");
      await user.request("soak events", "GET", "/api/v1/events");
      await user.request("soak notifications", "GET", "/api/v1/notifications?limit=5");
      if (cycle % 6 === 0) {
        const created = await user.request("soak reservation create", "POST", "/api/v1/reservations",
          { body: { items: [{ productId: fixtures.products.volume_d, quantity: 1 }] }, headers: { "Idempotency-Key": `load-${run}-soak-${randomUUID()}` }, expected: contended });
        const id = created.body?.data?.reservationId ?? created.body?.data?.id;
        if (id) await user.request("soak reservation cancel", "POST", `/api/v1/reservations/${id}/cancel`, { headers: { "Idempotency-Key": `load-${run}-soak-cancel-${randomUUID()}` }, expected: contended });
      }
      await think(3000, 6000);
    });
  }));
  const sellingSellers = fixtures.sellers.slice(5, 5 + sellers);
  const selling = Promise.all(sellerSessions.map(async (user, index) => {
    const seller = sellingSellers[index];
    await think(0, index * 1000);
    await untilDeadline(deadline, async () => {
      const sale = await user.request("soak checkout", "POST", "/api/v1/sales/checkout",
        { body: { channel: "PDV", locationId: seller.locationId, items: [{ productId: fixtures.products.volume_b, quantity: 1 }] }, headers: { "Idempotency-Key": `load-${run}-soak-sale-${randomUUID()}` }, expected: contended });
      const saleId = sale.body?.data?.saleId;
      if (saleId) {
        await user.request("soak pix confirmation", "POST", `/api/v1/sales/${saleId}/payments/manual-confirmation`,
          { body: { integrationChannel: "PIX_AREA", proofReference: `SOAK-${randomUUID().slice(0, 8)}`.toUpperCase() }, headers: { "Idempotency-Key": `load-${run}-soak-pay-${randomUUID()}` }, expected: contended });
      }
      await user.request("soak my sales", "GET", "/api/v1/pdv/sales");
      await think(15000, 25000);
    });
  }));
  await Promise.all([reading, selling, sampler]);
  const summary = metrics.finish().summary();
  return { ...summary, outbox: samples, trends: summary.routes.map((route) => ({ label: route.label, p95SlopeMsPerMinute: trend(route.minutes) })) };
}

function tally(results) {
  return results.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] ?? 0) + 1 }), {});
}
