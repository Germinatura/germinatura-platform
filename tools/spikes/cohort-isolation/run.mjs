#!/usr/bin/env node
// SPIKE runner (LOCAL ONLY, disposable database): automated evidence for the cohort isolation candidate of PR 2
// (ADR 0011). Phase 1: clean fixtures → spike.sql → schema diff, spike isolation test and the whole existing pgTAP
// suite. Phase 2: rich dataset → snapshot → spike.sql → preservation proof of the conversion itself → isolation test →
// Data API over HTTP → Realtime end to end (if the Realtime container runs) → backup with `supabase db dump`, restore
// into an empty local schema exactly as the runbook does, compare and re-run the isolation test on the restored copy.
//   node tools/spikes/cohort-isolation/run.mjs --out=<dir> [--skip-suite]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { localTarget, psql, run } from "../../upgrade-check/local.mjs";
import { columnsOf, compareSnapshots, snapshotSql } from "../../upgrade-check/snapshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const option = (name, fallback = null) => {
  const found = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!found) return fallback;
  return found.includes("=") ? found.slice(found.indexOf("=") + 1) : true;
};
const out = String(option("out", join(tmpdir(), "germinatura-cohort-spike")));
mkdirSync(out, { recursive: true });
const supabase = (args, extra = {}) => run(root, `supabase ${args.join(" ")}`, process.execPath, [join(root, "tools", "run-supabase.mjs"), ...args], extra);
const COHORT_B = "c0000000-0000-4000-8000-000000002027";
const SLICE = ["categories", "products", "product_prices", "product_images", "product_stock_alerts", "finance_manual_entries", "portal_highlights"];
const report = [];
const evidence = (title, ok, lines = []) => { report.push({ title, ok, lines }); console.log(`${ok ? "✔" : "✘"} ${title}`); };

function tap(text) {
  const lines = text.split("\n");
  const plan = Number(lines.find((line) => /^1\.\.\d+/.test(line))?.slice(3) ?? 0);
  const failed = lines.filter((line) => line.startsWith("not ok"));
  const passed = lines.filter((line) => line.startsWith("ok")).length;
  return { plan, passed, failed, ok: plan > 0 && passed === plan && failed.length === 0 };
}
const spikeTest = (target, database = "postgres") => tap(psql(target, `create extension if not exists pgtap;\n${readFileSync(join(here, "spike_test.sql"), "utf8")}`, [], { database, allowFailure: true }).stdout);

function schemaObjects(sql) {
  const pick = (pattern) => new Set([...sql.matchAll(pattern)].map((match) => match[1]));
  return {
    tables: pick(/^CREATE TABLE (?:IF NOT EXISTS )?("?[\w]+"?\."?[\w]+"?)/gm),
    views: pick(/^CREATE (?:OR REPLACE )?VIEW ("?[\w]+"?\."?[\w]+"?)/gm),
    policies: pick(/^CREATE POLICY ("?[^"]+"?) ON ("?[\w]+"?\."?[\w]+"?)/gm),
    triggers: pick(/^CREATE (?:OR REPLACE )?TRIGGER ("?[\w]+"? \w+ [^\n]+ ON "?[\w]+"?\."?[\w]+"?)/gm),
  };
}
const diffSets = (before, after) => ({ added: [...after].filter((item) => !before.has(item)).sort(), removed: [...before].filter((item) => !after.has(item)).sort() });

async function http(target, path, { token = null, header = null, method = "GET", body = null, profile = null } = {}) {
  const headers = { apikey: target.anonKey, Authorization: `Bearer ${token ?? target.anonKey}` };
  if (header) headers["x-germinatura-cohort"] = header;
  if (profile) headers["Accept-Profile"] = profile;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${target.apiUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

async function login(target, email, password) {
  const response = await fetch(`${target.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: target.anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const json = await response.json();
  if (!json.access_token) throw new Error(`login ${email} falhou: ${response.status}`);
  return json.access_token;
}

// Persistent second cohort and accounts for the HTTP and Realtime checks (local synthetic values only).
function seedSecondCohort(target) {
  psql(target, `
    insert into public.cohorts (id, name, year, slug, status) values ('${COHORT_B}', 'Turma 2027', 2027, '2027', 'ACTIVE') on conflict (id) do nothing;
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, phone_change_token, email_change_token_current, reauthentication_token,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', '1c000000-0000-4000-8000-0000000000bb', 'authenticated', 'authenticated', 'spike.b@institutojef.org.br',
      extensions.crypt('SpikeLocal123!', extensions.gen_salt('bf')), now(), '', '', '', '', '', '', '',
      '{"provider":"email","providers":["email"]}', '{"name":"Spike Turma B","username":"spike.turma.b"}', now(), now())
    on conflict (id) do nothing;
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), '1c000000-0000-4000-8000-0000000000bb', '1c000000-0000-4000-8000-0000000000bb',
      '{"sub":"1c000000-0000-4000-8000-0000000000bb","email":"spike.b@institutojef.org.br","email_verified":true}', 'email', now(), now(), now())
    on conflict do nothing;
    update public.user_cohorts set status = 'INACTIVE' where user_id = '1c000000-0000-4000-8000-0000000000bb' and cohort_id <> '${COHORT_B}';
    insert into public.user_cohorts (user_id, cohort_id) values ('1c000000-0000-4000-8000-0000000000bb', '${COHORT_B}') on conflict do nothing;
    insert into public.user_roles (user_id, role_id) select '1c000000-0000-4000-8000-0000000000bb', id from public.roles where key = 'ADMIN' on conflict do nothing;
    insert into public.categories (id, name, slug, active, sort_order, cohort_id)
      values ('5a000000-0000-4000-8000-0000000000bb', 'Spike HTTP B', 'spike-http-b', true, 1, '${COHORT_B}') on conflict (id) do nothing;
    insert into public.products (id, category_id, sku, slug, name, active, published)
      values ('5b000000-0000-4000-8000-0000000000bb', '5a000000-0000-4000-8000-0000000000bb', 'SPIKE-HTTP-B', 'spike-http-b', 'Spike HTTP B', true, true) on conflict (id) do nothing;
    insert into public.product_prices (product_id, amount_cents, valid_from, created_by)
      select '5b000000-0000-4000-8000-0000000000bb', 1234, now() - interval '1 day', '10000000-0000-4000-8000-000000000001'
      where not exists (select 1 from public.product_prices where product_id = '5b000000-0000-4000-8000-0000000000bb');`);
}

async function dataApi(target) {
  const lines = [];
  let ok = true;
  const expect = (label, condition, detail) => { ok &&= condition; lines.push(`${condition ? "✔" : "✘"} ${label}${detail ? ` — ${detail}` : ""}`); };
  const admin = await login(target, "admin.teste@institutojef.org.br", "Admin123!");
  const adminB = await login(target, "spike.b@institutojef.org.br", "SpikeLocal123!");

  const anonProducts = await http(target, "/rest/v1/products?select=sku&sku=eq.SPIKE-HTTP-B");
  expect("anon não vê produto publicado de outra turma", anonProducts.status === 200 && anonProducts.json?.length === 0, `HTTP ${anonProducts.status}`);
  const anonEmbed = await http(target, "/rest/v1/products?select=sku,categories(slug),product_prices(amount_cents)&limit=3");
  expect("embedding por FK através das views (products → categories, product_prices)", anonEmbed.status === 200 && Array.isArray(anonEmbed.json) && anonEmbed.json.every((row) => "categories" in row && "product_prices" in row), `HTTP ${anonEmbed.status}`);
  const adminA = await http(target, "/rest/v1/categories?select=slug,cohort_id&slug=like.spike-http-*", { token: admin });
  expect("admin da Turma 2026 não lê a categoria da 2027", adminA.status === 200 && adminA.json?.length === 0, `HTTP ${adminA.status}`);
  const adminAHeaderB = await http(target, "/rest/v1/categories?select=slug&slug=like.spike-http-*", { token: admin, header: COHORT_B });
  expect("nem pedindo a 2027 pelo header", adminAHeaderB.status === 200 && adminAHeaderB.json?.length === 0, `HTTP ${adminAHeaderB.status}`);
  const adminBRead = await http(target, "/rest/v1/categories?select=slug,cohort_id&slug=like.spike-http-*", { token: adminB });
  expect("admin da 2027 lê a própria categoria", adminBRead.status === 200 && adminBRead.json?.[0]?.cohort_id === COHORT_B, `HTTP ${adminBRead.status}`);
  const baseSchema = await http(target, "/rest/v1/categories?select=slug", { token: admin, profile: "cohort_data" });
  expect("o schema das tabelas base não é exposto pela Data API", baseSchema.status === 406, `HTTP ${baseSchema.status}`);
  const write = await http(target, "/rest/v1/categories", { token: admin, method: "POST", body: { name: "Direta", slug: "spike-direta" } });
  expect("escrita direta na view é negada (grants da tabela base)", write.status === 401 || write.status === 403, `HTTP ${write.status}`);
  const rpcCross = await http(target, "/rest/v1/rpc/save_catalog_category", { token: admin, method: "POST", body: {
    p_category_id: "5a000000-0000-4000-8000-0000000000bb", p_expected_revision: 1, p_name: "Invadida", p_slug: "spike-http-b", p_active: true,
    p_sort_order: 1, p_reason: "Tentativa entre turmas", p_idempotency_key: `spike-http-cross-${Date.now()}`, p_correlation_id: crypto.randomUUID() } });
  expect("RPC SECURITY DEFINER via Data API não alcança registro de outra turma", rpcCross.json?.message === "CATEGORY_NOT_FOUND", `HTTP ${rpcCross.status} ${rpcCross.json?.message ?? ""}`);
  const rpcAll = await http(target, "/rest/v1/rpc/save_catalog_category", { token: admin, header: "all", method: "POST", body: {
    p_category_id: null, p_expected_revision: null, p_name: "Sem turma", p_slug: "spike-http-all", p_active: true,
    p_sort_order: 1, p_reason: "Escrita sem turma concreta", p_idempotency_key: `spike-http-all-${Date.now()}`, p_correlation_id: crypto.randomUUID() } });
  expect("escrita em contexto sem turma concreta é recusada", rpcAll.json?.message === "COHORT_REQUIRED", `HTTP ${rpcAll.status} ${rpcAll.json?.message ?? ""}`);
  const rpcOwn = await http(target, "/rest/v1/rpc/save_catalog_category", { token: adminB, method: "POST", body: {
    p_category_id: null, p_expected_revision: null, p_name: "Spike HTTP B2", p_slug: "spike-http-b2", p_active: true,
    p_sort_order: 2, p_reason: "Categoria da turma B", p_idempotency_key: `spike-http-own-${Date.now()}`, p_correlation_id: crypto.randomUUID() } });
  const ownCohort = psql(target, "select cohort_id from cohort_data.categories where slug = 'spike-http-b2';");
  expect("RPC da 2027 grava na 2027", rpcOwn.status === 200 && ownCohort === COHORT_B, `HTTP ${rpcOwn.status}, cohort ${ownCohort}`);
  return { ok, lines, tokens: { admin, adminB } };
}

async function realtime(target, tokens) {
  const running = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", `supabase_realtime_${target.projectId}`], { encoding: "utf8" });
  if (running.status !== 0 || running.stdout.trim() !== "true") return { ok: null, lines: ["Realtime não está rodando neste stack local: verificação não executada."] };
  const require = createRequire(join(root, "apps", "portal", "package.json"));
  const { createClient } = require("@supabase/supabase-js");
  const lines = [];
  psql(target, "alter publication supabase_realtime add table cohort_data.categories;");
  const viewPublish = psql(target, "alter publication supabase_realtime add table public.categories;", [], { allowFailure: true });
  lines.push(`${viewPublish.status !== 0 ? "✔" : "✘"} a view não pode ser publicada — ${(viewPublish.stderr.split("\n")[0] ?? "").trim()}`);
  const listen = async (token, label) => {
    // The user's JWT must reach the socket before the join (setAuth); otherwise Realtime registers the subscription as anon.
    const client = createClient(target.apiUrl, target.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    if (token) await client.realtime.setAuth(token);
    const received = [];
    const channel = client.channel(`spike-${label}`).on("postgres_changes", { event: "INSERT", schema: "cohort_data", table: "categories" }, (payload) => received.push(payload.new));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Realtime ${label}: sem SUBSCRIBED em 20 s`)), 20000);
      channel.subscribe((status) => { if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); } });
    });
    return { client, channel, received };
  };
  let ok = viewPublish.status !== 0;
  try {
    const a = await listen(tokens.admin, "a");
    const b = await listen(tokens.adminB, "b");
    const anon = await listen(null, "anon");
    // Insert only once Realtime has registered the three subscriptions (SUBSCRIBED can precede the registration).
    for (let attempt = 0; attempt < 40 && Number(psql(target, "select count(*) from realtime.subscription where entity = 'cohort_data.categories'::regclass;")) < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    lines.push(`assinaturas registradas: ${psql(target, "select string_agg(claims_role::text || ':' || coalesce(claims ->> 'sub', 'anon'), ', ' order by claims_role::text) from realtime.subscription where entity = 'cohort_data.categories'::regclass;")}`);
    psql(target, `insert into public.categories (name, slug, active, sort_order) values ('Realtime A', 'spike-rt-a', true, 1);
      insert into public.categories (name, slug, active, sort_order, cohort_id) values ('Realtime B', 'spike-rt-b', true, 1, '${COHORT_B}');`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const slugs = (list) => list.map((row) => row.slug).filter((slug) => slug.startsWith("spike-rt-")).sort().join(",");
    const checks = [[a, "assinante da 2026 (admin)", "spike-rt-a"], [b, "assinante da 2027 (admin)", "spike-rt-b"], [anon, "assinante anônimo (controle: só a turma padrão)", "spike-rt-a"]];
    for (const [subscriber, label, expected] of checks) {
      const got = slugs(subscriber.received);
      ok &&= got === expected;
      lines.push(`${got === expected ? "✔" : "✘"} ${label} recebeu: [${got}] (esperado ${expected})`);
    }
    await anon.client.removeAllChannels();
    await a.client.removeAllChannels();
    await b.client.removeAllChannels();
  } catch (error) {
    ok = false;
    lines.push(`✘ ${error instanceof Error ? error.message : error}`);
  } finally {
    psql(target, "alter publication supabase_realtime drop table cohort_data.categories;");
  }
  return { ok, lines };
}

async function main() {
  const target = localTarget(root, "cohort-spike");
  const spikeSql = readFileSync(join(here, "spike.sql"), "utf8");

  // Phase 1 — clean fixtures.
  supabase(["db", "reset"]);
  supabase(["db", "dump", "--local", "-f", join(out, "schema-before.sql")]);
  psql(target, spikeSql);
  supabase(["db", "dump", "--local", "-f", join(out, "schema-after.sql")]);
  const before = schemaObjects(readFileSync(join(out, "schema-before.sql"), "utf8"));
  const after = schemaObjects(readFileSync(join(out, "schema-after.sql"), "utf8"));
  const diff = Object.fromEntries(Object.keys(before).map((kind) => [kind, diffSets(before[kind], after[kind])]));
  evidence("Diff de schema (pg_dump antes × depois do spike)", true, Object.entries(diff).map(([kind, { added, removed }]) =>
    `${kind}: +${added.length} −${removed.length}${added.length ? ` | + ${added.slice(0, 12).join(", ")}${added.length > 12 ? ", …" : ""}` : ""}${removed.length ? ` | − ${removed.slice(0, 12).join(", ")}${removed.length > 12 ? ", …" : ""}` : ""}`));
  const clean = spikeTest(target);
  evidence(`Teste de isolamento do spike (banco limpo): ${clean.passed}/${clean.plan}`, clean.ok, clean.failed);
  if (!option("skip-suite")) {
    const suite = run(root, "suíte pgTAP existente sobre o banco convertido", process.execPath, [join(root, "tools", "run-supabase.mjs"), "test", "db"], { capture: true, allowFailure: true });
    writeFileSync(join(out, "pgtap-suite.log"), suite.stdout + suite.stderr);
    const files = [...suite.stdout.matchAll(/^\/\S+\/(\w+\.sql)\s+\(Wstat: \d+.*?Tests: (\d+) Failed: (\d+)\)/gm)].map((match) => `${match[1]}: ${match[3]} de ${match[2]}`);
    const failures = [...suite.stdout.matchAll(/# Failed test \d+: "([^"]+)"/g)].map((match) => match[1]);
    const total = suite.stdout.match(/Files=(\d+), Tests=(\d+)/);
    evidence(`Suíte pgTAP existente sobre o banco convertido (${total ? `${total[1]} arquivos, ${total[2]} testes` : "?"})`, null,
      [`Arquivos com falha: ${files.join("; ") || "nenhum"}`, ...failures.map((name) => `falha: ${name}`)]);
  }

  // Phase 2 — populated database, the conversion itself, HTTP, Realtime, backup and restore.
  supabase(["db", "reset"]);
  run(root, "dataset sintético rico (8 dias)", process.execPath, [join(root, "tools", "dev-seed", "rich-seed.mjs"), "--days=8"], { env: { DEVSEED_UPGRADE_CHECK: "1" } });
  const preConversion = JSON.parse(psql(target, snapshotSql({ perRow: true })));
  psql(target, spikeSql);
  const postConversion = JSON.parse(psql(target, snapshotSql({ columns: columnsOf(preConversion), perRow: true })));
  const conversion = compareSnapshots(preConversion, postConversion, { requireSameTuples: true });
  evidence("Conversão sobre banco populado: todas as linhas, valores e tuplas preservados", conversion.ok,
    [...conversion.problems, `tabelas movidas (agora em cohort_data): ${SLICE.join(", ")}; linhas: ${SLICE.map((name) => `${name}=${postConversion.tables[name]?.rows}`).join(", ")}`]);
  const populated = spikeTest(target);
  evidence(`Teste de isolamento do spike (banco populado): ${populated.passed}/${populated.plan}`, populated.ok, populated.failed);

  seedSecondCohort(target);
  const api = await dataApi(target);
  evidence("Data API (HTTP, PostgREST real)", api.ok, api.lines);
  const realtimeResult = await realtime(target, api.tokens);
  evidence("Realtime (postgres_changes ponta a ponta)", realtimeResult.ok, realtimeResult.lines);

  // The devseed schema is local dataset tooling (absent from production); it is not part of the backup.
  psql(target, "drop schema if exists devseed cascade;");
  const source = JSON.parse(psql(target, snapshotSql({ perRow: true })));
  writeFileSync(join(out, "source.json"), JSON.stringify(source));
  supabase(["db", "dump", "--local", "-f", join(out, "schema.sql")]);
  supabase(["db", "dump", "--local", "--data-only", "--use-copy", "-x", "storage.buckets_vectors,storage.vector_indexes", "-f", join(out, "data.sql")]);
  // Restore as the runbook: schema from the migrations (here reset + spike.sql, which stands for the PR 2 migration),
  // application data and the buckets the migrations create emptied, then data.sql in replica mode. schema.sql is
  // not used: `db dump` leaves out the auth and storage schemas, so it lacks the storage policies and auth triggers.
  supabase(["db", "reset", "--no-seed"]);
  psql(target, spikeSql);
  psql(target, `do $$ declare v_tables text; begin
      select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v_tables
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname in ('public', 'private', 'cohort_data');
      execute 'truncate ' || v_tables || ', storage.objects, storage.buckets cascade';
    end $$;`);
  const emptyPublic = psql(target, "select coalesce(sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint), 0) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public', 'private', 'cohort_data');");
  const restore = spawnSync("docker", ["exec", "-i", target.container, "psql", "-U", "postgres", "-d", "postgres", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-X", "-q"], {
    input: ["set session_replication_role = replica;", readFileSync(join(out, "data.sql"), "utf8")].join("\n"),
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
  });
  const restored = restore.status === 0 ? JSON.parse(psql(target, snapshotSql({ columns: columnsOf(source), perRow: true }))) : null;
  const restoreComparison = restored ? compareSnapshots(source, restored) : { ok: false, problems: [`restauração falhou: ${(restore.stderr || "").split("\n").slice(0, 3).join(" ")}`] };
  evidence(`Backup (supabase db dump) e restauração pelo procedimento do runbook (linhas da aplicação antes da carga: ${emptyPublic})`, restoreComparison.ok, restoreComparison.problems);
  const afterRestore = restored ? spikeTest(target) : { ok: false, passed: 0, plan: 0, failed: ["não executado"] };
  evidence(`Teste de isolamento do spike no banco restaurado: ${afterRestore.passed}/${afterRestore.plan}`, afterRestore.ok, afterRestore.failed);

  const markdown = [
    "# Spike de isolamento por turma — evidências", "",
    ...report.flatMap(({ title, ok, lines }) => [`## ${ok === null ? "ℹ️" : ok ? "✅" : "❌"} ${title}`, "", ...lines.map((line) => `- ${line}`), ""]),
  ].join("\n");
  writeFileSync(join(out, "report.md"), markdown);
  console.log(`\n${markdown}\nArquivos em ${out}`);
  supabase(["db", "reset"], { allowFailure: true });
  if (report.some(({ ok }) => ok === false)) process.exit(2);
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exit(1); });
