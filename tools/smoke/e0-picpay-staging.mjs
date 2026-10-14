#!/usr/bin/env node
// Operational smoke of E0 (PicPay cohort attribution + isolation) in STAGING ONLY — the 12 steps of the E0 checklist.
//
// How it runs: `gh workflow run deploy-staging.yml --ref develop -f e0_attribution_smoke=true` (job `e0-smoke`, environment
// `staging`, develop only). The report goes to the job log and summary.
//
// Safety:
// - Targets: only the staging Workers and the staging Supabase project `ttupvkygtkfspkgfihbl`; the production project is
//   refused by name (tests/load/lib/guard.mjs plus the checks below), before any request.
// - People: three synthetic accounts `smoke.e0.<run>.*` (ADMIN_MASTER, ADMIN of the default cohort, ADMIN of a synthetic
//   cohort "Smoke E0 B <run>"), inserted like the load fixtures (pre-confirmed, no e-mail) with a random password that
//   only lives in this process. Every checked action goes through the Portal with a real session, so RBAC and RLS are the
//   application's. SQL (Supabase Management API) only provisions, reads evidence for the report, and cleans up.
// - Irreversible step: isolation is activated only if steps 1–6 all pass and no PicPay evidence outside this run is left
//   without a cohort (its owner would not be proven by the system: the run stops and reports it, attributing nothing).
// - Never printed: passwords, keys, tokens, cookies.
// - Cleanup: the three accounts are deactivated and banned, the ADMIN_MASTER grant is removed, the synthetic cohort is
//   archived. The synthetic evidence, its attributions and the audit stay (immutable proof of the run).
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stagingTarget } from "../../tests/load/lib/guard.mjs";
import { literal, stagingSql } from "../../tests/load/lib/staging-sql.mjs";

export const EXPECTED_STAGING_REF = "ttupvkygtkfspkgfihbl";
export const PRODUCTION_REF = "emfmofwbazvvvasetoqu";
export const ACTIVATION_REASON = "Smoke E0 staging — validação do isolamento PicPay multi-turma";

/** Fail-closed: the staging target of the load harness, and exactly the expected staging project, never production. */
export function e0Target(env = process.env) {
  for (const value of [env.LOAD_SUPABASE_PROJECT_ID, env.LOAD_SUPABASE_URL, env.LOAD_PORTAL_URL, env.LOAD_PDV_URL]) {
    if (value && String(value).includes(PRODUCTION_REF)) throw new Error("Alvo recusado: projeto de produção.");
  }
  const target = stagingTarget(env);
  if (target.projectRef !== EXPECTED_STAGING_REF) throw new Error(`Projeto recusado: só ${EXPECTED_STAGING_REF} (staging) é aceito.`);
  if (new URL(target.supabaseUrl).hostname !== `${EXPECTED_STAGING_REF}.supabase.co`) throw new Error("URL do Supabase diferente do staging esperado.");
  return target;
}

/** A Portal session: its own cookie jar, the Portal origin, raw or JSON bodies. Never logs headers or bodies. */
class Session {
  constructor(origin, label) { this.origin = origin; this.label = label; this.cookies = new Map(); }
  keep(response) {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(header) || value === "") this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  async call(method, path, { json, csv, key } = {}) {
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const headers = { Origin: this.origin, "Sec-Fetch-Site": "same-origin", Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    if (csv !== undefined) headers["Content-Type"] = "text/csv";
    if (key) headers["Idempotency-Key"] = key;
    const response = await fetch(`${this.origin}${path}`, {
      method, headers, redirect: "manual", signal: AbortSignal.timeout(60000),
      body: json !== undefined ? JSON.stringify(json) : csv,
    });
    this.keep(response);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body };
  }
  async login(username, password) {
    const result = await this.call("POST", "/api/auth/login", { json: { identifier: username, password } });
    if (result.status !== 200) throw new Error(`Login recusado para ${this.label} (${result.status}).`);
  }
  async cohort(value) {
    const result = await this.call("POST", "/api/v1/session/cohort", { json: { cohort: value } });
    if (result.status !== 200) throw new Error(`Seleção de turma recusada para ${this.label} (${result.status}).`);
  }
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const shift = (day, days) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const brl = (cents) => cents === null || cents === undefined ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * The 12 steps against `target` (Portal origin) with `sql` (provisioning, evidence for the report, cleanup). The command
 * line entry below only ever calls it with the guarded staging target.
 */
export async function runSmoke(target, sql) {
  const run = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const day = shift(today(), -1);
  const period = { from: shift(today(), -30), to: today() };
  const report = { run, projectRef: target.projectRef, sha: process.env.LOAD_SHA ?? null, steps: [], notes: [], cleanup: [] };
  const step = (number, name, ok, detail = "") => {
    report.steps.push({ number, name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${number}. ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };
  const one = async (query) => (await sql(query))[0] ?? null;
  const people = {};
  let cohortB = null;
  let master = null;
  let stopped = null;

  try {
    // Provisioning ---------------------------------------------------------------------------------------------------
    const cohortA = await one(`select id, name from public.cohorts where is_default and status = 'ACTIVE'`);
    if (!cohortA) throw new Error("Turma padrão ativa não encontrada em staging.");
    report.cohortA = cohortA;
    report.isolationBefore = (await one(`select enforced from private.picpay_attribution_settings`))?.enforced ?? null;
    for (const tag of ["master", "admina", "adminb"]) {
      const id = randomUUID();
      const email = `smoke.e0.${run}.${tag}@institutojef.org.br`;
      const username = `smokee0${run}${tag}`.slice(0, 32);
      await sql(`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token,
          email_change_token_new, email_change, phone_change_token, email_change_token_current, reauthentication_token,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${literal(id)}, 'authenticated', 'authenticated', ${literal(email)},
          extensions.crypt(${literal(password)}, extensions.gen_salt('bf', 6)), now(), '', '', '', '', '', '', '',
          '{"provider":"email","providers":["email"]}', jsonb_build_object('name', ${literal(`Smoke E0 ${tag}`)}, 'username', ${literal(username)}), now(), now());
        insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), ${literal(id)}, ${literal(id)}, jsonb_build_object('sub', ${literal(id)}, 'email', ${literal(email)}, 'email_verified', true),
          'email', now(), now(), now());`);
      people[tag] = { id, username };
    }
    await sql(`insert into public.admin_masters (user_id, granted_by, reason, correlation_id)
      values (${literal(people.master.id)}, null, ${literal(`Smoke E0 staging ${run} (conta temporária)`)}, gen_random_uuid())`);
    await sql(`insert into cohort_data.user_roles (user_id, role_id, cohort_id)
      select ${literal(people.admina.id)}, id, ${literal(cohortA.id)} from public.roles where key = 'ADMIN' on conflict do nothing`);
    report.people = Object.fromEntries(Object.entries(people).map(([tag, person]) => [tag, person.id]));

    master = new Session(target.portal, "ADMIN_MASTER");
    await master.login(people.master.username, password);
    // The synthetic cohort B, created by ADMIN_MASTER through the Portal.
    for (let year = 2100; !cohortB && year >= 2050; year -= 1) {
      const created = await master.call("POST", "/api/v1/admin/cohorts", { key: `e0-smoke-${run}-${year}`,
        json: { name: `Smoke E0 B ${run}`, year, slug: `smoke-e0-b-${run}`, status: "ACTIVE" } });
      if (created.status === 201) cohortB = created.body.data;
    }
    if (!cohortB) throw new Error("Não foi possível criar a turma sintética B.");
    report.cohortB = { id: cohortB.id, name: cohortB.name };
    await sql(`
      insert into public.user_cohorts (user_id, cohort_id) values (${literal(people.adminb.id)}, ${literal(cohortB.id)}) on conflict do nothing;
      insert into cohort_data.user_roles (user_id, role_id, cohort_id)
        select ${literal(people.adminb.id)}, id, ${literal(cohortB.id)} from public.roles where key in ('ADMIN', 'CONSUMIDOR') on conflict do nothing;
      delete from cohort_data.user_roles where user_id = ${literal(people.adminb.id)} and cohort_id = ${literal(cohortA.id)};
      delete from public.user_cohorts where user_id = ${literal(people.adminb.id)} and cohort_id = ${literal(cohortA.id)};`);
    const adminA = new Session(target.portal, "ADMIN da Turma A");
    await adminA.login(people.admina.username, password);
    await adminA.cohort(cohortA.id);
    const adminB = new Session(target.portal, "ADMIN da Turma B");
    await adminB.login(people.adminb.username, password);
    await adminB.cohort(cohortB.id);

    const books = async (session) => {
      const balances = await session.call("GET", "/api/v1/admin/finance/balances");
      const indicators = await session.call("GET", `/api/v1/admin/finance/indicators?from=${period.from}&to=${period.to}`);
      if (balances.status !== 200 || indicators.status !== 200) throw new Error(`Livros indisponíveis para ${session.label} (${balances.status}/${indicators.status}).`);
      return {
        free: balances.body.data.freeBalanceCents, vault: balances.body.data.vaultBalanceCents, receivables: balances.body.data.receivablesBalanceCents,
        operatingProfit: indicators.body.data.totals.operatingProfitCents, pendingLines: indicators.body.data.pending.statementLinesPending,
      };
    };
    const lineCounts = async () => Object.fromEntries((await sql(`
      select coalesce(case when cohort_id is null then 'global' when cohort_id = ${literal(cohortA.id)} then 'A'
        when cohort_id = ${literal(cohortB.id)} then 'B' else 'outras' end, 'global') as owner, count(*)::int as lines
      from private.picpay_line_cohorts group by 1`)).map((row) => [row.owner, row.lines]));
    report.linesBefore = await lineCounts();
    report.booksBefore = { A: await books(adminA), B: await books(adminB) };

    // 1. Initial state, and the legacy without a cohort ----------------------------------------------------------------
    await master.cohort(cohortA.id);
    const initial = await master.call("GET", "/api/v1/admin/finance/picpay/attribution");
    const legacy = (initial.body?.data?.files ?? []).filter((file) => file.unassigned > 0);
    report.legacyUnassigned = legacy.map((file) => ({ number: file.number, file: file.fileName, source: file.sourceType, scope: file.scope,
      items: file.unassigned, cents: file.unassignedCents }));
    if (legacy.length > 0) {
      report.legacyLinks = await sql(`
        select line.import_id, coalesce(current.resolution::text, 'PENDENTE') as resolution, count(*)::int as lines, sum(line.amount_cents)::bigint as cents,
          count(*) filter (where current.payable_settlement_id is not null or current.manual_entry_id is not null or current.payment_attempt_id is not null
            or current.refund_entry_id is not null)::int as linked_to_record
        from public.picpay_statement_lines line
        join private.picpay_line_cohorts attribution on attribution.line_id = line.id and attribution.cohort_id is null
        left join private.picpay_statement_current_resolutions current on current.line_id = line.id
        group by 1, 2 order by 1, 2`);
      report.legacyTransactions = await one(`
        select count(*)::int as transactions, coalesce(sum(state.gross_cents), 0)::bigint as gross_cents,
          count(*) filter (where link.transaction_id is not null)::int as with_link_history
        from private.picpay_transaction_cohorts attribution
        join private.picpay_transaction_state state on state.transaction_id = attribution.transaction_id
        left join (select distinct transaction_id from cohort_data.picpay_transaction_links) link on link.transaction_id = attribution.transaction_id
        where attribution.cohort_id is null`);
    }
    if (!step(1, "Estado inicial: isolamento ainda não ativado e nenhum legado sem turma comprovada",
      initial.status === 200 && initial.body.data.enforced === false && legacy.length === 0,
      `HTTP ${initial.status}, isolamento ${initial.body?.data?.enforced ? "ativo" : "não ativado"}, ${legacy.length} arquivo(s) com evidência sem turma`)) {
      stopped = legacy.length > 0
        ? "Há evidência PicPay sem turma fora deste smoke: a propriedade não está comprovada pelo sistema."
        : "Passo 1 divergiu (o isolamento já estava ativo ou o estado não pôde ser lido).";
    }

    // 2. A cohort ADMIN neither imports nor attributes ---------------------------------------------------------------
    const csvA = ["data;movimento;descrição;tipo;valor", `${day};Pix enviado;Smoke E0 ${run} fornecedor A;Saída;-1.23;`,
      `${day};Dinheiro guardado;Smoke E0 ${run} guardado A;Saída;-2.34;`].join("\r\n");
    const csvMixed = ["data;movimento;descrição;tipo;valor", `${day};Pix enviado;Smoke E0 ${run} global 1;Saída;-3.45;`,
      `${day};Pix enviado;Smoke E0 ${run} global 2;Saída;-4.56;`].join("\r\n");
    if (!stopped) {
      const denied = await Promise.all([
        adminA.call("GET", "/api/v1/admin/finance/picpay/attribution"),
        adminA.call("POST", `/api/v1/admin/finance/picpay/files?fileName=e0-${run}-negado.csv&scope=COHORT&cohortId=${cohortA.id}`, { csv: csvA, key: `e0-${run}-deny-import` }),
        adminA.call("POST", "/api/v1/admin/finance/picpay/attribution", { key: `e0-${run}-deny-assign`,
          json: { importId: randomUUID(), statementLineIds: [], transactionIds: [], reason: "Tentativa de ADMIN de turma", expectedCount: 1, expectedTotalCents: 0 } }),
        adminA.call("POST", "/api/v1/admin/finance/picpay/attribution/isolation", { key: `e0-${run}-deny-activate`, json: { reason: "Tentativa de ADMIN de turma" } }),
      ]);
      if (!step(2, "ADMIN de turma não importa, não atribui e não ativa", denied.every((result) => result.status === 403),
        `status ${denied.map((result) => result.status).join("/")}`)) stopped = "Passo 2 divergiu.";
    }

    // 3. ADMIN_MASTER imports a file declared as Turma A's -----------------------------------------------------------
    let fileA = null;
    if (!stopped) {
      const missing = await master.call("POST", `/api/v1/admin/finance/picpay/files?fileName=e0-${run}-sem.csv`, { csv: csvA, key: `e0-${run}-none` });
      const imported = await master.call("POST", `/api/v1/admin/finance/picpay/files?fileName=e0-${run}-turma-a.csv&scope=COHORT&cohortId=${cohortA.id}`,
        { csv: csvA, key: `e0-${run}-import-a` });
      fileA = imported.body?.data ?? null;
      if (!step(3, "ADMIN_MASTER importa o CSV declarado da Turma A (e a declaração é obrigatória)",
        missing.status === 422 && imported.status === 201 && fileA?.declaration?.scope === "COHORT" && fileA.declaration.attributed === 2,
        `sem declaração HTTP ${missing.status}; importação HTTP ${imported.status}, ${fileA?.declaration?.attributed ?? "?"} item(ns) atribuído(s)`)) stopped = "Passo 3 divergiu.";
    }

    // 4. ADMIN_MASTER imports a MISTO/GLOBAL file -----------------------------------------------------------------------
    let fileMixed = null;
    if (!stopped) {
      const imported = await master.call("POST", `/api/v1/admin/finance/picpay/files?fileName=e0-${run}-misto.csv&scope=GLOBAL`,
        { csv: csvMixed, key: `e0-${run}-import-mixed` });
      fileMixed = imported.body?.data ?? null;
      if (!step(4, "ADMIN_MASTER importa o CSV misto/global", imported.status === 201 && fileMixed?.declaration?.scope === "GLOBAL"
        && fileMixed.declaration.attributed === 0, `HTTP ${imported.status}, ${fileMixed?.declaration?.attributed ?? "?"} atribuído(s)`)) stopped = "Passo 4 divergiu.";
    }

    // 5. The mixed file stays without a cohort, even imported inside Turma A -------------------------------------------
    const lineOf = async (suffix) => one(`select line.id, attribution.cohort_id from public.picpay_statement_lines line
      join private.picpay_line_cohorts attribution on attribution.line_id = line.id where line.description = ${literal(`Smoke E0 ${run} ${suffix}`)}`);
    const lines = {};
    if (!stopped) {
      for (const suffix of ["fornecedor A", "guardado A", "global 1", "global 2"]) lines[suffix] = await lineOf(suffix);
      const status = await master.call("GET", "/api/v1/admin/finance/picpay/attribution");
      const mixedRow = status.body?.data?.files?.find((file) => file.id === fileMixed.id);
      const ok = lines["global 1"]?.cohort_id === null && lines["global 2"]?.cohort_id === null
        && lines["fornecedor A"]?.cohort_id === cohortA.id && lines["guardado A"]?.cohort_id === cohortA.id
        && mixedRow?.unassigned === 2 && mixedRow.unassignedCents === -801 && mixedRow.scope === "GLOBAL";
      if (!step(5, "Arquivo misto fica sem turma (nem a da tela, nem a padrão); arquivo da A fica na A", ok,
        `misto: ${mixedRow?.unassigned ?? "?"} sem turma, ${brl(mixedRow?.unassignedCents)}`)) stopped = "Passo 5 divergiu.";
    }

    // 6. Numbers before activation, and nothing else left to attribute ----------------------------------------------
    if (!stopped) {
      report.booksBeforeActivation = { A: await books(adminA), B: await books(adminB) };
      const a0 = report.booksBefore.A; const a1 = report.booksBeforeActivation.A;
      const b0 = report.booksBefore.B; const b1 = report.booksBeforeActivation.B;
      const status = await master.call("GET", "/api/v1/admin/finance/picpay/attribution");
      const otherUnassigned = (status.body?.data?.files ?? []).filter((file) => file.unassigned > 0 && file.id !== fileMixed.id);
      // Isolation still off: every cohort still reads every line (the reason to activate), so A and B move alike.
      if (!step(6, "Antes da ativação: números esperados nas duas turmas e nada além do misto sem turma",
        a1.free - a0.free === -1158 && a1.vault - a0.vault === 234 && b1.free - b0.free === -1158 && b1.vault - b0.vault === 234 && otherUnassigned.length === 0,
        `A: livre ${brl(a1.free - a0.free)}, Cofrinho ${brl(a1.vault - a0.vault)}; B: livre ${brl(b1.free - b0.free)}, Cofrinho ${brl(b1.vault - b0.vault)}; `
          + `${otherUnassigned.length} outro(s) arquivo(s) com evidência sem turma`)) stopped = "Passo 6 divergiu.";
    }

    if (stopped) {
      report.notes.push(`Parado antes da ativação: ${stopped} O isolamento NÃO foi ativado.`);
      return report;
    }

    // 7. Activation (irreversible), idempotent, no way back ------------------------------------------------------------
    const activated = await master.call("POST", "/api/v1/admin/finance/picpay/attribution/isolation", { key: `e0-${run}-activate`, json: { reason: ACTIVATION_REASON } });
    const again = await master.call("POST", "/api/v1/admin/finance/picpay/attribution/isolation", { key: `e0-${run}-activate-again`, json: { reason: "Segunda ativação do smoke" } });
    const back = await master.call("PUT", "/api/v1/admin/finance/picpay/attribution/isolation", { json: { reason: "Tentativa de desligar" } });
    const oldSwitch = await master.call("PUT", "/api/v1/admin/finance/picpay/attribution/enforcement", { json: { enforced: false, reason: "Tentativa de desligar" } });
    const after = await master.call("GET", "/api/v1/admin/finance/picpay/attribution");
    report.isolationAfter = after.body?.data?.enforced ?? null;
    step(7, "Ativação do isolamento: ativa, segunda ativação sem efeito, sem caminho de volta",
      activated.status === 201 && activated.body.data.activatedNow === true && again.status === 200 && again.body.data.activatedNow === false
        && again.body.data.reason === ACTIVATION_REASON && back.status === 405 && [404, 405].includes(oldSwitch.status) && after.body.data.enforced === true,
      `ativação HTTP ${activated.status}, de novo HTTP ${again.status} (sem efeito: ${again.body?.data?.activatedNow === false}), PUT HTTP ${back.status}, rota antiga HTTP ${oldSwitch.status}`);

    // 8. Turma A sees only A ---------------------------------------------------------------------------------------------
    const a2 = await books(adminA);
    const a0 = report.booksBefore.A;
    const importsA = await adminA.call("GET", "/api/v1/admin/finance/statement-imports");
    const namesA = (importsA.body?.data ?? []).map((item) => item.fileName);
    step(8, "Turma A só vê o que é da A (o misto saiu dos números)",
      a2.free - a0.free === -357 && a2.vault - a0.vault === 234
        && namesA.includes(`e0-${run}-turma-a.csv`) && !namesA.includes(`e0-${run}-misto.csv`),
      `A: livre ${brl(a2.free - a0.free)} (esperado ${brl(-357)}), Cofrinho ${brl(a2.vault - a0.vault)}; importações visíveis incluem o da A: `
        + `${namesA.includes(`e0-${run}-turma-a.csv`)}, o misto: ${namesA.includes(`e0-${run}-misto.csv`)}`);

    // 9. Turma B sees only B (nothing yet) ---------------------------------------------------------------------------------
    const b2 = await books(adminB);
    const importsB = await adminB.call("GET", "/api/v1/admin/finance/statement-imports");
    const linesB = await adminB.call("GET", `/api/v1/admin/finance/statement-imports/${fileA.id}/lines`);
    step(9, "Turma B só vê o que é da B (nada da A, nada do misto)",
      b2.free === 0 && b2.vault === 0 && b2.receivables === 0 && (importsB.body?.data ?? []).length === 0 && linesB.status === 404 && b2.pendingLines === 0,
      `B: livre ${brl(b2.free)}, Cofrinho ${brl(b2.vault)}, recebíveis ${brl(b2.receivables)}, ${(importsB.body?.data ?? []).length} importação(ões) visível(is), `
        + `linhas da A HTTP ${linesB.status}`);

    // 10. Later attribution to B; A → B refused ----------------------------------------------------------------------
    await master.cohort(cohortB.id);
    const selection = { importId: null, statementLineIds: [lines["global 1"].id], transactionIds: [] };
    const preview = await master.call("POST", "/api/v1/admin/finance/picpay/attribution/preview", { json: selection });
    const assigned = await master.call("POST", "/api/v1/admin/finance/picpay/attribution", { key: `e0-${run}-assign-b`,
      json: { ...selection, reason: `Smoke E0 ${run}: linha atribuída à Turma B`, expectedCount: 1, expectedTotalCents: -345 } });
    const b3 = await books(adminB);
    const a3 = await books(adminA);
    await master.cohort(cohortA.id);
    const toA = await master.call("POST", "/api/v1/admin/finance/picpay/attribution", { key: `e0-${run}-assign-a`,
      json: { ...selection, reason: `Smoke E0 ${run}: tentativa de mover para A`, expectedCount: 1, expectedTotalCents: -345 } });
    step(10, "Atribuição posterior à B aparece só na B; mover para a A é recusado",
      preview.status === 200 && preview.body.data.count === 1 && preview.body.data.totalCents === -345 && assigned.status === 201
        && b3.free === -345 && a3.free === a2.free && toA.status === 409 && toA.body?.code === "PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT",
      `prévia ${preview.body?.data?.count ?? "?"}/${brl(preview.body?.data?.totalCents)}, atribuição HTTP ${assigned.status}; B livre ${brl(b3.free)}; `
        + `A inalterada: ${a3.free === a2.free}; para a A: HTTP ${toA.status} ${toA.body?.code ?? ""}`);
    report.batchB = assigned.body?.data?.batchId ?? null;

    // 11. Manual decisions -------------------------------------------------------------------------------------------
    const classified = await adminA.call("POST", `/api/v1/admin/finance/statement-lines/${lines["fornecedor A"].id}/resolve`,
      { key: `e0-${run}-classify-a`, json: { action: "CLASSIFICAR", category: "MATERIAIS" } });
    const globalByAdmin = await adminA.call("POST", `/api/v1/admin/finance/statement-lines/${lines["global 2"].id}/resolve`,
      { key: `e0-${run}-classify-global`, json: { action: "CLASSIFICAR", category: "MATERIAIS" } });
    const mixedForA = await adminA.call("GET", `/api/v1/admin/finance/statement-imports/${fileMixed.id}/lines`);
    await master.cohort("all");
    const fromAll = await master.call("POST", `/api/v1/admin/finance/statement-lines/${lines["global 2"].id}/resolve`,
      { key: `e0-${run}-classify-all`, json: { action: "CLASSIFICAR", category: "MATERIAIS" } });
    await master.cohort(cohortA.id);
    const resolutionA = await one(`select cohort_id from cohort_data.picpay_statement_line_resolutions where line_id = ${literal(lines["fornecedor A"].id)}
      order by sequence desc limit 1`);
    step(11, "Decisões manuais: ADMIN da A classifica a linha da A; linha sem turma recusada para ADMIN; \"Todas\" recusa",
      classified.status === 200 && resolutionA?.cohort_id === cohortA.id && globalByAdmin.status === 403
        && globalByAdmin.body?.code === "PICPAY_EVIDENCE_NOT_ATTRIBUTED" && mixedForA.status === 404
        && fromAll.status >= 400 && fromAll.status < 500 && fromAll.body?.code === "COHORT_REQUIRED",
      `classificação HTTP ${classified.status} (turma gravada = A: ${resolutionA?.cohort_id === cohortA.id}); linha sem turma HTTP ${globalByAdmin.status} `
        + `${globalByAdmin.body?.code ?? ""}; misto para a A HTTP ${mixedForA.status}; "Todas" HTTP ${fromAll.status} ${fromAll.body?.code ?? ""}`);

    // 12. State and audit ------------------------------------------------------------------------------------------------
    const settings = await one(`select enforced, reason from private.picpay_attribution_settings`);
    const attributions = await sql(`
      select case when cohort_id = ${literal(cohortA.id)} then 'A' when cohort_id = ${literal(cohortB.id)} then 'B' else 'outra' end as cohort,
        origin::text, count(*)::int as items
      from cohort_data.picpay_evidence_attributions
      where statement_line_id in (${Object.values(lines).map((line) => literal(line.id)).join(", ")})
      group by 1, 2 order by 1, 2`);
    const audit = await sql(`
      select action, case when cohort_id is null then 'GLOBAL' when cohort_id = ${literal(cohortA.id)} then 'A'
        when cohort_id = ${literal(cohortB.id)} then 'B' else 'outra' end as cohort, count(*)::int as rows
      from public.audit_logs
      where action in ('finance.picpay.isolation_activated', 'finance.picpay.evidence_assigned', 'finance.picpay.file_imported')
        and actor_id = ${literal(people.master.id)}
      group by 1, 2 order by 1, 2`);
    report.attributions = attributions;
    report.audit = audit;
    const has = (rows, predicate) => rows.some(predicate);
    step(12, "Estado e auditoria: isolamento ativo; atribuições por origem e turma; auditoria global da ativação e por turma das atribuições",
      settings?.enforced === true && settings.reason === ACTIVATION_REASON
        && has(attributions, (row) => row.cohort === "A" && row.origin === "IMPORT_DECLARATION" && row.items === 2)
        && has(attributions, (row) => row.cohort === "B" && row.origin === "ASSIGNMENT" && row.items === 1) && attributions.length === 2
        && has(audit, (row) => row.action === "finance.picpay.isolation_activated" && row.cohort === "GLOBAL" && row.rows === 1)
        && has(audit, (row) => row.action === "finance.picpay.evidence_assigned" && row.cohort === "B" && row.rows === 1),
      `isolamento ${settings?.enforced ? "ativo" : "inativo"}; atribuições ${attributions.map((row) => `${row.cohort}/${row.origin}=${row.items}`).join(", ")}; `
        + `auditoria ${audit.map((row) => `${row.action}@${row.cohort}=${row.rows}`).join(", ")}`);

    report.linesAfter = await lineCounts();
    report.booksAfter = { A: await books(adminA), B: await books(adminB) };
    return report;
  } catch (error) {
    report.notes.push(`Erro: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  } finally {
    // Cleanup: archive the synthetic cohort, then retire the accounts (the ADMIN_MASTER grant first). Evidence and audit stay.
    try {
      if (cohortB && master) {
        const archived = await master.call("PATCH", `/api/v1/admin/cohorts/${cohortB.id}`,
          { json: { name: cohortB.name, status: "ARCHIVED", reason: `Fim do smoke E0 ${run}` } });
        report.cleanup.push(`turma sintética B arquivada: HTTP ${archived.status}`);
      }
      const ids = Object.values(people).map((person) => literal(person.id));
      if (ids.length > 0) {
        await sql(`
          delete from public.admin_masters where user_id in (${ids.join(", ")});
          update public.profiles set active = false where id in (${ids.join(", ")});
          update auth.users set banned_until = 'infinity' where id in (${ids.join(", ")});
          delete from auth.refresh_tokens where user_id::text in (${ids.join(", ")});
          delete from auth.sessions where user_id in (${ids.join(", ")});`);
        report.cleanup.push("contas sintéticas desativadas e bloqueadas, sessões encerradas, concessão de ADMIN_MASTER removida");
      }
    } catch (error) {
      report.cleanup.push(`limpeza incompleta: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function markdown(report) {
  const passed = report.steps.filter((item) => item.ok).length;
  const books = (label, value) => value ? `${label}: livre ${brl(value.free)}, Cofrinho ${brl(value.vault)}, recebíveis ${brl(value.receivables)}, `
    + `resultado operacional 30 dias ${brl(value.operatingProfit)}, linhas pendentes ${value.pendingLines}` : `${label}: —`;
  return [
    `## Smoke E0 em staging — ${passed}/12 PASS`,
    "",
    `- Execução: \`${report.run}\` · projeto \`${report.projectRef}\` · develop \`${report.sha ?? "?"}\``,
    `- Turma A: ${report.cohortA?.name ?? "?"} (\`${report.cohortA?.id ?? "?"}\`) · Turma B sintética: \`${report.cohortB?.id ?? "?"}\``,
    `- Contas sintéticas: ${Object.entries(report.people ?? {}).map(([tag, id]) => `${tag} \`${id}\``).join(", ")}`,
    `- Isolamento antes: ${report.isolationBefore === true ? "ativo" : report.isolationBefore === false ? "não ativado" : "?"} · depois: ${report.isolationAfter === true ? "ativo" : report.isolationAfter === false ? "não ativado" : "não executado"}`,
    "",
    "| Passo | Resultado | Detalhe |",
    "| --- | --- | --- |",
    ...report.steps.map((item) => `| ${item.number}. ${item.name} | ${item.ok ? "PASS" : "FAIL"} | ${item.detail} |`),
    "",
    `- Linhas do Extrato por turma antes: ${JSON.stringify(report.linesBefore ?? {})} · depois: ${JSON.stringify(report.linesAfter ?? {})}`,
    `- Antes: ${books("A", report.booksBefore?.A)}; ${books("B", report.booksBefore?.B)}`,
    `- Antes da ativação: ${books("A", report.booksBeforeActivation?.A)}; ${books("B", report.booksBeforeActivation?.B)}`,
    `- Depois: ${books("A", report.booksAfter?.A)}; ${books("B", report.booksAfter?.B)}`,
    `- Evidência sem turma fora do smoke: ${JSON.stringify(report.legacyUnassigned ?? [])}`,
    ...(report.legacyLinks ? [`- Vínculos estruturais das linhas sem turma: ${JSON.stringify(report.legacyLinks)}`] : []),
    ...(report.legacyTransactions ? [`- Transações sem turma: ${JSON.stringify(report.legacyTransactions)}`] : []),
    `- Atribuições do smoke: ${JSON.stringify(report.attributions ?? [])}`,
    `- Auditoria: ${JSON.stringify(report.audit ?? [])}`,
    `- Limpeza: ${report.cleanup.join("; ") || "—"}`,
    ...report.notes.map((note) => `- ${note}`),
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = e0Target();
  const report = await runSmoke(target, stagingSql(target));
  const text = markdown(report);
  console.log(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  const passed = report.steps.length === 12 && report.steps.every((item) => item.ok);
  process.exit(passed ? 0 : 1);
}
