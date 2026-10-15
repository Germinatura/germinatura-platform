#!/usr/bin/env node
// Rich, deterministic, synthetic dataset for DEV/LOCAL only (`pnpm dev:seed:rich`, `pnpm dev:seed:rich:reset`).
// It never accepts a connection string: SQL runs only through `docker exec` into the local Supabase database
// container, and the run aborts unless every check says "local". No real personal data, no e-mail, no PicPay.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = new Set(process.argv.slice(2));
const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const DAYS = daysArg ? Math.max(8, Math.min(180, Number(daysArg.slice(7)) || 90)) : 90;
const SLOTS = 4;

function fail(message) {
  console.error(`dev:seed:rich recusado: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------- guards (fail closed)
function localTarget() {
  if (process.env.NODE_ENV === "production") fail("NODE_ENV=production.");
  // The upgrade check (tools/upgrade-check) seeds the CI runner's own local Supabase; it only lifts the CI check.
  const upgradeCheck = process.env.DEVSEED_UPGRADE_CHECK === "1";
  for (const name of ["CI", "SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD"]) {
    if (name === "CI" && upgradeCheck) continue;
    if (process.env[name]) fail(`a variável ${name} indica um ambiente que não é o desenvolvimento local.`);
  }
  const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) fail("supabase/config.toml sem project_id.");
  let status;
  try {
    status = execFileSync(process.execPath, [join(root, "tools", "run-supabase.mjs"), "status", "-o", "env"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("o Supabase local não está rodando (pnpm supabase:start).");
  }
  const value = (key) => status.match(new RegExp(`^${key}="?([^"\\r\\n]+)"?$`, "m"))?.[1];
  const apiUrl = value("API_URL");
  const dbUrl = value("DB_URL");
  const serviceKey = value("SERVICE_ROLE_KEY") ?? value("SECRET_KEY");
  const isLocal = (url) => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; } };
  if (!apiUrl || !dbUrl || !isLocal(apiUrl) || !isLocal(dbUrl)) fail("o Supabase em uso não é local.");
  if (!serviceKey) fail("chave local do Storage indisponível.");
  const container = `supabase_db_${projectId}`;
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", container], { encoding: "utf8" });
  if (inspect.status !== 0 || inspect.stdout.trim() !== "true") fail(`contêiner local ${container} não encontrado.`);
  return { apiUrl, serviceKey, container };
}

function psql(target, sql, { quiet = true } = {}) {
  const result = spawnSync("docker", ["exec", "-i", target.container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", ...(quiet ? ["-q", "-A", "-t"] : [])],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function assertLocalFixtures(target) {
  // Production starts from the bootstrap administrator; only local databases carry the seed fixtures.
  const fixture = psql(target, "select count(*) from auth.users where id = '10000000-0000-4000-8000-000000000001' and email = 'admin.teste@institutojef.org.br';");
  if (fixture !== "1") fail("o banco não tem as fixtures locais (supabase/seed.sql); rode pnpm dev:seed:rich:reset.");
  const done = psql(target, "select count(*) from information_schema.tables where table_schema = 'devseed' and table_name = 'settings';");
  if (done !== "0" && psql(target, "select count(*) from devseed.settings where key = 'done';") !== "0") {
    fail("o dataset já foi gerado neste banco; use pnpm dev:seed:rich:reset para recriar do zero.");
  }
}

// ---------------------------------------------------------------------------------------- deterministic generator
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20261001);
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (probability) => random() < probability;
const q = (value) => value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const arr = (values) => values.length ? `array[${values.map(q).join(",")}]::text[]` : "array[]::text[]";
const js = (value) => `${q(JSON.stringify(value))}::jsonb`;
const pad = (value, size = 2) => String(value).padStart(size, "0");
// One line per product, as the checkout expects.
const cart = (lines) => Object.values(lines.reduce((merged, line) => { merged[line.p] = { p: line.p, q: (merged[line.p]?.q ?? 0) + line.q }; return merged; }, {}));

const catalog = [
  { key: "brig", name: "Brigadeiros", food: true, price: [350, 600], items: ["tradicional", "beijinho", "ninho com nutella", "pistache", "café", "maracujá", "churros", "paçoca", "limão", "morango", "ovomaltine", "coco queimado"] },
  { key: "pote", name: "Bolos de pote", food: true, price: [900, 1400], items: ["chocolate", "cenoura", "red velvet", "prestígio", "limão siciliano", "ninho", "maracujá", "doce de leite", "abacaxi com coco", "brownie", "morango"] },
  { key: "assa", name: "Salgados assados", food: true, price: [550, 900], items: ["esfiha de carne", "esfiha de frango", "enroladinho de salsicha", "empada de palmito", "empada de frango", "folhado de queijo", "pão de batata", "croissant de presunto", "joelho", "pão de queijo", "torta de frango"] },
  { key: "frit", name: "Salgados fritos", food: true, price: [500, 800], items: ["coxinha", "risole de carne", "bolinha de queijo", "kibe", "pastel de carne", "pastel de queijo", "croquete", "enroladinho frito", "coxinha de costela", "bolinho de aipim", "risole de milho"] },
  { key: "bebi", name: "Bebidas", food: true, price: [400, 900], items: ["água sem gás", "água com gás", "refrigerante lata", "refrigerante zero", "chá gelado", "energético", "isotônico", "água de coco", "achocolatado", "café gelado", "limonada"] },
  { key: "suco", name: "Sucos naturais", food: true, price: [700, 1100], items: ["laranja", "uva", "maracujá", "abacaxi com hortelã", "limão", "acerola", "manga", "goiaba", "morango", "melancia", "caju"] },
  { key: "cook", name: "Cookies e brownies", food: true, price: [600, 1200], items: ["cookie tradicional", "cookie red velvet", "cookie de aveia", "brownie tradicional", "brownie de nutella", "blondie", "cookie duplo chocolate", "brownie de doce de leite", "cookie de amendoim", "brownie com nozes", "cookie de limão"] },
  { key: "trufa", name: "Trufas e bombons", food: true, price: [450, 800], items: ["trufa de maracujá", "trufa de morango", "trufa de café", "bombom de uva", "bombom de morango", "trufa de limão", "trufa branca", "bombom de cereja", "trufa de coco", "trufa de amarula", "bombom crocante"] },
  { key: "pao", name: "Pães e sanduíches", food: true, price: [800, 1500], items: ["misto quente", "sanduíche natural", "bauru", "wrap de frango", "pão com linguiça", "sanduíche de atum", "hot dog", "x-salada", "baguete de peru", "sanduíche vegetariano", "pão de mel"] },
  { key: "cami", name: "Camisetas da turma", food: false, price: [4500, 6500], items: ["camiseta P", "camiseta M", "camiseta G", "camiseta GG", "baby look P", "baby look M", "baby look G", "moletom M", "moletom G", "regata M", "regata G"] },
  { key: "cane", name: "Canecas e copos", food: false, price: [2000, 3800], items: ["caneca branca", "caneca preta", "copo térmico", "copo long drink", "garrafa térmica", "caneca mágica", "tirante com copo", "copo de acrílico", "squeeze", "caneca de alumínio", "taça de acrílico"] },
  { key: "chav", name: "Chaveiros e adesivos", food: false, price: [600, 1500], items: ["chaveiro do brasão", "chaveiro abridor", "adesivo da turma", "kit de adesivos", "botton", "pulseira", "chaveiro de acrílico", "marcador de página", "ímã de geladeira", "adesivo holográfico", "patch bordado"] },
  { key: "kit", name: "Kits de formatura", food: false, price: [8000, 16000], items: ["kit festa", "kit presente", "kit lembrança", "kit família", "kit premium", "kit pais", "kit mini", "kit doces", "kit salgados", "kit madrinha", "kit padrinho"] },
  { key: "doce", name: "Doces de festa", food: true, price: [300, 700], items: ["cajuzinho", "olho de sogra", "camafeu", "casadinho", "bicho de pé", "quindim", "pé de moleque", "cocada", "doce de abóbora", "suspiro", "bem-casado"] },
];

const firstNames = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Felipe", "Gabriela", "Heitor", "Isabela", "João", "Karina", "Lucas", "Marina", "Nicolas", "Olívia", "Pedro", "Quésia", "Rafael", "Sofia", "Tiago", "Úrsula", "Vitor", "Wesley", "Yasmin", "Zeca"];
const lastNames = ["Exemplo", "Fictício", "Modelo", "Teste", "Amostra", "Simulado", "Demonstração", "Sintético"];

function scenario() {
  const out = [];
  const add = (line) => out.push(line);
  const batch = (day, slot) => add(`select devseed.batch(${day}, ${slot}, ${DAYS});`);

  // People: synthetic names, fictitious institutional addresses prefixed with "seed.".
  const sellers = Array.from({ length: 20 }, (_, index) => `s${pad(index + 1)}`);
  const consumers = Array.from({ length: 60 }, (_, index) => `c${pad(index + 1)}`);
  const products = [];
  batch(0, 0);
  sellers.forEach((key, index) => add(`select devseed.person(${q(key)}, ${q(`${firstNames[index % firstNames.length]} ${lastNames[index % lastNames.length]} Vendedor`)}, ${q(`vendedor${pad(index + 1)}`)}, array['CONSUMIDOR','VENDEDOR']);`));
  consumers.forEach((key, index) => add(`select devseed.person(${q(key)}, ${q(`${firstNames[(index + 7) % firstNames.length]} ${lastNames[(index + 3) % lastNames.length]}`)}, ${q(`cliente${pad(index + 1)}`)}, array['CONSUMIDOR']);`));
  add(`select devseed.person('f01', 'Fernanda Financeiro Exemplo', 'financeiro01', array['CONSUMIDOR','FINANCEIRO']);`);
  add(`select devseed.person('e01', 'Eduardo Estoque Exemplo', 'estoque01', array['CONSUMIDOR','ESTOQUE']);`);
  add(`select devseed.person('m01', 'Mariana Comunicação Exemplo', 'comunicacao01', array['CONSUMIDOR','COMUNICACAO']);`);
  ["MAQ-01", "MAQ-02", "MAQ-03"].forEach((code, index) => add(`select devseed.terminal(${q(code)}, ${q(`Maquininha ${index + 1}`)});`));

  catalog.forEach((category, categoryIndex) => {
    add(`select devseed.category(${q(category.key)}, ${q(category.name)}, ${q(`seed-${category.key}`)}, ${100 + categoryIndex});`);
    category.items.forEach((item, itemIndex) => {
      const key = `p${pad(products.length + 1, 3)}`;
      const price = Math.round(int(category.price[0], category.price[1]) / 10) * 10;
      const name = `${category.name.replace(/s$/, "").replace(/ de .*/, "")} ${item}`.replace(/^Camiseta da turma /, "Camiseta ").replace(/^Bolo de pote /, "Bolo de pote ");
      products.push({ key, category: category.key, food: category.food, price, index: products.length, itemIndex });
      add(`select devseed.product(${q(key)}, ${q(category.key)}, ${q(name.charAt(0).toUpperCase() + name.slice(1))}, ${q(`seed-${category.key}-${itemIndex + 1}`)}, ${q(category.food ? "Produzido para os eventos da turma." : "Produto oficial da turma.")}, ${price}, true, ${category.food});`);
    });
  });
  // States: drafts, inactive, public but never stocked, and the rest on sale.
  const draft = new Set(products.filter((product) => product.index % 23 === 5).map((product) => product.key));
  const inactive = new Set(products.filter((product) => product.index % 31 === 7).map((product) => product.key));
  const neverStocked = new Set(products.filter((product) => product.index % 19 === 11).map((product) => product.key));
  const onSale = products.filter((product) => !draft.has(product.key) && !inactive.has(product.key));
  const stocked = onSale.filter((product) => !neverStocked.has(product.key));
  for (const product of products) {
    if (draft.has(product.key)) continue;
    if (inactive.has(product.key)) { add(`select devseed.product_state(${q(product.key)}, false, false, false);`); continue; }
    add(`select devseed.product_state(${q(product.key)}, true, true, ${!neverStocked.has(product.key) || product.index % 2 === 0});`);
  }

  const suppliers = Array.from({ length: 15 }, (_, index) => `f${pad(index + 1)}`);
  suppliers.forEach((key, index) => add(`select devseed.supplier(${q(key)}, ${q(`Fornecedor Fictício ${pad(index + 1)} Ltda`)}, ${q(`${firstNames[(index + 11) % firstNames.length]} Contato`)});`));

  // Promotions of every kind (some short, some open-ended, a coupon with a global limit).
  const byCategory = (key) => products.filter((product) => product.category === key && !draft.has(product.key) && !inactive.has(product.key)).map((product) => product.key);
  add(`select devseed.promotion('qp-brig', 'SEED-BRIG3', 'Três brigadeiros por R$ 9,90', ${arr(byCategory("brig").slice(0, 6))}, ${js({ type: "QUANTIDADE_PRECO", groupQuantity: 3, groupPriceCents: 990 })}, 110, null, null);`);
  add(`select devseed.promotion('pct-bebi', 'SEED-BEBIDA10', 'Bebidas com 10%', ${arr(byCategory("bebi").slice(0, 5))}, ${js({ type: "PERCENTUAL", percentageBasisPoints: 1000 })}, 120, 21, null);`);
  add(`select devseed.promotion('fix-cami', 'SEED-CAMISETA', 'Camiseta por R$ 39,90', ${arr(byCategory("cami").slice(0, 4))}, ${js({ type: "VALOR_FIXO_UNITARIO", fixedUnitPriceCents: 3990 })}, 130, 45, null);`);
  add(`select devseed.promotion('lp-cook', 'SEED-COOKIE32', 'Leve 3 cookies, pague 2', ${arr(byCategory("cook").slice(0, 5))}, ${js({ type: "LEVE_PAGUE", buyQuantity: 3, payQuantity: 2, maxGroupsPerLine: null })}, 140, null, null);`);
  add(`select devseed.promotion('esc-frit', 'SEED-SALGADOS', 'Salgados: quanto mais, menor o preço', ${arr(byCategory("frit").slice(0, 6))}, ${js({ type: "ESCALONADA", tiers: [{ minQuantity: 4, percentageBasisPoints: 500 }, { minQuantity: 8, percentageBasisPoints: 1000 }] })}, 150, 30, null);`);
  const combo = [byCategory("frit")[0], byCategory("bebi")[2]];
  add(`select devseed.promotion('combo-lanche', 'SEED-COMBO', 'Combo coxinha + refrigerante', ${arr(combo)}, ${js({ type: "COMBO_MIX", comboPriceCents: 1100, maxCombosPerCart: 3, components: combo.map((key) => ({ p: key, q: 1 })) })}, 160, null, null);`);
  add(`select devseed.promotion('cupom', 'SEED-CUPOM', 'Cupom da formatura', ${arr(onSale.slice(0, 40).map((product) => product.key))}, ${js({ type: "CUPOM", code: "FORMATURA10", discount: { kind: "PERCENTUAL", percentageBasisPoints: 1000 } })}, 170, null, 40);`);

  // Day 0 restocking: a big first purchase received the same day, then distribution to every seller.
  batch(0, 1);
  const orders = [];
  const purchase = (key, items) => { orders.push(key); add(`select devseed.purchase(${q(key)}, ${q(pick(suppliers))}, ${js(items)}, ${int(0, 3) * 1500}, ${q(pick(["PIX", "Boleto", "Transferência"]))});`); };
  for (let index = 0; index < stocked.length; index += 10) {
    const items = stocked.slice(index, index + 10).map((product) => ({ p: product.key, q: product.food ? int(120, 260) : int(30, 80), c: Math.round(product.price * (0.35 + random() * 0.2)) }));
    purchase(`po-000-${index / 10}`, items);
    add(`select devseed.receive(${q(`po-000-${index / 10}`)}, 1.0);`);
    add(`select devseed.settle(${q(`po-000-${index / 10}`)}, 1.0);`);
  }
  batch(0, 2);
  const assortment = new Map();
  for (const seller of sellers) {
    const mine = [...stocked].sort(() => random() - 0.5).slice(0, 18).map((product) => product.key);
    assortment.set(seller, mine);
    mine.forEach((key) => add(`select devseed.distribute(${q(`d0-${seller}-${key}`)}, ${q(seller)}, ${q(key)}, ${int(6, 14)});`));
  }

  // Communication set-up.
  const shares = [];
  [["WHATSAPP", "Grupo da turma"], ["INSTAGRAM", "Stories da comissão"], ["MURAL", "Cartaz da escola"], ["PRESENCIAL", "Panfleto no intervalo"], ["OUTRO", "Lista de e-mails"]].forEach(([channel, title], index) => {
    shares.push(`sh${index + 1}`);
    add(`select devseed.share(${q(`sh${index + 1}`)}, ${q(title)}, ${q(channel)}, ${arr(onSale.slice(index * 5, index * 5 + 4).map((product) => product.key))}, null, ${int(10, 60)});`);
  });
  sellers.slice(0, 10).forEach((seller, index) => {
    shares.push(`sl${index + 1}`);
    add(`select devseed.share(${q(`sl${index + 1}`)}, ${q(`Link de ${seller}`)}, ${q(pick(["WHATSAPP", "INSTAGRAM"]))}, ${arr(assortment.get(seller).slice(0, 3))}, ${q(seller)}, ${int(3, 30)});`);
  });
  consumers.slice(0, 12).forEach((consumer, index) => add(`select devseed.preference(${q(consumer)}, ${q(pick(["NOVOS_PRODUTOS", "PROMOCOES", "RIFAS", "EVENTOS"]))}, false);`));

  // A seller attributes a sale to a commission campaign or to one of their own links.
  const sharesFor = (seller) => [...shares.filter((key) => key.startsWith("sh")), ...(sellers.indexOf(seller) < 10 ? [`sl${sellers.indexOf(seller) + 1}`] : [])];

  // The calendar.
  let saleCount = 0;
  let reservationCount = 0;
  const raffles = [
    { key: "r1", name: "Rifa da cesta de chocolates", start: 4, numbers: 100, end: "DRAW", endDay: 40 },
    { key: "r2", name: "Rifa do kit churrasco", start: 28, numbers: 60, end: "CLOSE", endDay: 62 },
    { key: "r3", name: "Rifa do fone sem fio", start: 66, numbers: 200, end: null, endDay: null },
    { key: "r4", name: "Rifa do vale-presente", start: 18, numbers: 50, end: "CANCEL", endDay: 20 },
    { key: "r5", name: "Rifa da bicicleta", start: 75, numbers: 150, end: "PAUSE", endDay: 86 },
  ];
  const raffleNumbersUsed = new Map(raffles.map((raffle) => [raffle.key, new Set()]));
  const closeoutSince = new Map();
  for (let day = 1; day < DAYS; day += 1) {
    const weekday = (new Date(Date.now() - (DAYS - day) * 86400000).getDay());
    const weekend = weekday === 0 || weekday === 6;
    const growth = 0.8 + 0.5 * (day / DAYS);
    const salesToday = Math.round((weekend ? 6 : 14) * growth + int(-2, 2));
    const active = [...sellers].sort(() => random() - 0.5).slice(0, weekend ? 5 : 10);
    const cashSellers = new Set(active.filter(() => chance(0.6)));

    batch(day, 0);
    cashSellers.forEach((seller) => add(`select devseed.open_shift(${q(`${day}-${seller}`)}, ${q(seller)}, ${int(0, 4) * 2000});`));
    if (day % 7 === 1) {
      for (const seller of sellers) {
        [...assortment.get(seller)].sort(() => random() - 0.5).slice(0, 10).forEach((key) => add(`select devseed.distribute(${q(`d${day}-${seller}-${key}`)}, ${q(seller)}, ${q(key)}, ${int(4, 10)});`));
      }
    }
    if (day % 5 === 3) {
      const key = `po-${pad(day, 3)}`;
      const items = [...stocked].sort(() => random() - 0.5).slice(0, int(4, 9)).map((product) => ({ p: product.key, q: product.food ? int(60, 160) : int(15, 40), c: Math.round(product.price * (0.35 + random() * 0.2)) }));
      purchase(key, items);
      if (day % 30 === 18) add(`select devseed.cancel_order(${q(key)});`);
      else {
        add(`select devseed.receive(${q(key)}, ${day % 20 === 13 ? 0.5 : 1.0});`);
        add(`select devseed.settle(${q(key)}, ${day % 3 === 0 ? 0.5 : 1.0});`);
      }
    }
    if (day === 30 || day === 60) onSale.filter((product) => product.index % 4 === day % 4).forEach((product) => add(`select devseed.reprice(${q(product.key)}, ${Math.round(product.price * (1.05 + random() * 0.1) / 10) * 10}, 'd${day}');`));
    if (day % 30 === 15) add(`select devseed.central_count(${q(`count-${day}`)}, 9, ${day !== 45});`);

    for (let slot = 1; slot <= 2; slot += 1) {
      batch(day, slot);
      for (let index = 0; index < Math.ceil(salesToday / 2); index += 1) {
        const seller = pick(active);
        const items = cart(Array.from({ length: int(1, 3) }, () => ({ p: pick(assortment.get(seller)), q: int(1, 3) })));
        const channel = cashSellers.has(seller) && chance(0.35) ? "DINHEIRO" : pick(["CREDITO", "CREDITO", "DEBITO", "PIX", "PIX"]);
        saleCount += 1;
        add(`select devseed.sale(${q(`v${pad(saleCount, 5)}`)}, ${q(seller)}, ${js(items)}, ${q(channel)}, ${chance(0.03) ? "'FORMATURA10'" : "null"}, ${chance(0.08) ? q(pick(sharesFor(seller))) : "null"});`);
      }
      // Portal reservations against central stock, with every ending.
      for (let index = 0; index < (weekend ? 1 : 2); index += 1) {
        reservationCount += 1;
        const fate = day >= DAYS - 2 ? pick(["OPEN", "READY"]) : day >= DAYS - 4 ? "OPEN" : pick(["PICKED_PIX", "PICKED_CARD", "PICKED_CARD", "CANCELLED"]);
        const items = cart(Array.from({ length: int(1, 2) }, () => ({ p: pick(stocked).key, q: int(1, 3) })));
        add(`select devseed.reservation(${q(`res${pad(reservationCount, 4)}`)}, ${q(pick(consumers))}, ${js(items)}, ${q(fate)}, ${chance(0.1) ? q(pick(shares)) : "null"});`);
      }
    }

    batch(day, 3);
    for (const raffle of raffles) {
      if (day === raffle.start) add(`select devseed.raffle(${q(raffle.key)}, ${q(raffle.name)}, ${q(pick(stocked.filter((product) => !product.food)).key)}, ${raffle.numbers}, ${(raffle.endDay ?? DAYS + 20) - day});`);
      const open = day > raffle.start && (raffle.endDay === null || day < raffle.endDay) && raffle.end !== "CANCEL";
      if (open && chance(0.7)) {
        const used = raffleNumbersUsed.get(raffle.key);
        const numbers = [];
        while (numbers.length < int(1, 3) && used.size < raffle.numbers - 3) {
          const number = int(1, raffle.numbers);
          if (!used.has(number)) { used.add(number); numbers.push(number); }
        }
        if (numbers.length) add(`select devseed.raffle_sale(${q(`${raffle.key}-${day}`)}, ${q(raffle.key)}, ${q(pick(active))}, array[${numbers.join(",")}], ${chance(0.7) ? q(pick(consumers)) : "null"}, ${q(pick(["CREDITO", "DEBITO", "PIX"]))});`);
      }
      if (day === raffle.endDay && raffle.end) add(`select devseed.raffle_finish(${q(raffle.key)}, ${q(raffle.end)});`);
    }
    if (chance(0.04 * salesToday / 4) && saleCount > 5) add(`select devseed.refund(${q(`v${pad(saleCount - int(0, 4), 5)}`)}, 'Cliente desistiu da compra');`);
    if (chance(0.3)) {
      const seller = pick(active);
      add(`select devseed.loss(${q(`loss-${day}`)}, ${q(seller)}, ${q(pick(assortment.get(seller)))}, ${int(1, 3)}, ${q(pick(["DAMAGED", "EXPIRED", "MISSING", "AUTHORIZED_CONSUMPTION", "OPERATIONAL_ERROR"]))}, ${chance(0.75)});`);
    }
    cashSellers.forEach((seller) => add(`select devseed.close_shift(${q(`${day}-${seller}`)}, ${q(seller)}, ${chance(0.15) ? int(-3, 3) * 50 : 0});`));
    if (day % 7 === 0) {
      for (const seller of sellers.slice(0, 12)) {
        // Periods are at most seven days and never overlap: each starts the morning after the previous one.
        const since = Math.max((closeoutSince.get(seller) ?? 0) + 1, day - 6);
        add(`select devseed.closeout(${q(`co-${day}-${seller}`)}, ${q(seller)}, (select real_start from devseed.batches where day = ${since} and slot = 0));`);
        closeoutSince.set(seller, day);
      }
    }
    if (day % 15 === 2) add(`select devseed.announce(${q(`a${day}`)}, ${q(pick(["Cardápio da semana", "Reunião da comissão", "Arrecadação do mês", "Ensaio da formatura", "Doações de prendas", "Plantão de vendas"]))}, 'Mensagem do dataset de desenvolvimento para a turma.', ${day % 2 === 0 ? "null" : "array['VENDEDOR']"});`);
    if (day % 12 === 6 && day < DAYS - 20) add(`select devseed.event(${q(`ev${day}`)}, ${q(pick(["EVENTO", "CAMPANHA"]))}, ${q(pick(["Festa junina da turma", "Bazar de doces", "Noite do pastel", "Campanha do agasalho", "Feira de salgados", "Sessão de cinema"]))}, 'Evento do dataset de desenvolvimento.', ${int(2, 6)}, 'Quadra da escola', ${arr(onSale.slice(day % 20, day % 20 + 3).map((product) => product.key))}, ${q(day === 30 ? "CANCELLED" : "PUBLISHED")});`);
    if (day % 30 === 20) {
      add(`select devseed.entry(${q(`exp-transp-${day}`)}, 'EXPENSE', 'TRANSPORTE', 'PICPAY_EMPRESAS', null, ${int(8, 30) * 1000}, 'Frete das encomendas');`);
      add(`select devseed.entry(${q(`exp-mat-${day}`)}, 'EXPENSE', 'MATERIAIS', 'PICPAY_EMPRESAS', null, ${int(5, 25) * 1000}, 'Embalagens e etiquetas');`);
      add(`select devseed.entry(${q(`inc-mens-${day}`)}, 'INCOME', 'MENSALIDADES', 'PICPAY_EMPRESAS', null, ${int(40, 90) * 1000}, 'Mensalidades da turma');`);
      add(`select devseed.entry(${q(`trf-${day}`)}, 'TRANSFER', null, 'PICPAY_EMPRESAS', 'COFRINHO_PICPAY', ${int(10, 50) * 1000}, 'Reserva no cofrinho');`);
      if (day === 50) add(`select devseed.reverse_entry(${q(`exp-mat-${day}`)});`);
    }
    add("select devseed.drain_outbox();");
  }
  // Upcoming events, one draft, from "today".
  batch(DAYS - 1, 3);
  [["evf1", "EVENTO", "Baile de formatura", 25, "PUBLISHED"], ["evf2", "CAMPANHA", "Campanha da rifa da bicicleta", 6, "PUBLISHED"], ["evf3", "EVENTO", "Churrasco de confraternização", 12, "PUBLISHED"], ["evf4", "EVENTO", "Gincana da turma", 18, "DRAFT"]]
    .forEach(([key, kind, title, ahead, fate]) => add(`select devseed.event(${q(key)}, ${q(kind)}, ${q(title)}, 'Evento do dataset de desenvolvimento.', ${ahead}, 'Ginásio da escola', ${arr(onSale.slice(0, 3).map((product) => product.key))}, ${q(fate)});`));
  add("select devseed.drain_outbox();");
  return { sql: out.join("\n"), products, sellers, consumers, saleCount, reservationCount, draft };
}

// ------------------------------------------------------------------------------------- placeholder product images
function png(width, height, [r, g, b], stripe) {
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * row.length] = 0;
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor((x + y) / 24) % 2 === 0 && (x + y) % stripe < 6;
      const offset = y * row.length + 1 + x * 3;
      raw[offset] = band ? 255 : r; raw[offset + 1] = band ? 255 : g; raw[offset + 2] = band ? 255 : b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function uploadImages(target, products, draft) {
  const palette = [[244, 162, 97], [231, 111, 81], [42, 157, 143], [233, 196, 106], [38, 70, 83], [131, 56, 236], [58, 134, 255], [255, 0, 110], [251, 86, 7], [6, 214, 160], [17, 138, 178], [7, 59, 76], [239, 71, 111], [255, 209, 102]];
  const categories = [...new Set(products.map((product) => product.category))];
  const ids = new Map(psql(target, "select key || '|' || id from devseed.refs where kind = 'product';").split("\n").filter(Boolean).map((line) => line.split("|")));
  const lines = [];
  // About four out of five products get a picture; the rest show the empty state.
  for (const product of products.filter((item) => item.index % 5 !== 4 && !draft.has(item.key))) {
    const productId = ids.get(product.key);
    if (!productId) continue;
    const imageId = randomUUID();
    const path = `products/${productId}/${imageId}.png`;
    const response = await fetch(`${target.apiUrl}/storage/v1/object/product-images/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.serviceKey}`, apikey: target.serviceKey, "Content-Type": "image/png", "x-upsert": "false" },
      body: png(480, 360, palette[categories.indexOf(product.category) % palette.length], 40 + product.itemIndex * 7),
    });
    if (!response.ok) throw new Error(`upload da imagem falhou (${response.status})`);
    lines.push(`select devseed.image(${q(product.key)}, ${q(imageId)}, ${q(path)}, ${q(`Foto ilustrativa do produto ${product.key}`)});`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------- run
async function main() {
  const target = localTarget();
  if (args.has("--reset")) {
    console.log("Recriando o banco local (supabase db reset)…");
    execFileSync(process.execPath, [join(root, "tools", "run-supabase.mjs"), "db", "reset"], { cwd: root, stdio: "inherit" });
  }
  assertLocalFixtures(target);
  const started = Date.now();
  console.log("Carregando os auxiliares do dataset…");
  psql(target, readFileSync(join(here, "devseed.sql"), "utf8") + "\n" + readFileSync(join(here, "devseed-finish.sql"), "utf8"));
  const plan = scenario();
  const marker = `select devseed.batch(0, 2, ${DAYS});`;
  const [setup, calendar] = plan.sql.split(marker);
  console.log("Catálogo, pessoas, compras e promoções…");
  psql(target, setup);
  console.log("Imagens ilustrativas…");
  psql(target, `select devseed.batch(0, 1, ${DAYS});\n` + await uploadImages(target, plan.products, plan.draft));
  console.log(`Calendário de ${DAYS} dias (${plan.saleCount} vendas planejadas, ${plan.reservationCount} reservas)…`);
  psql(target, marker + calendar);
  console.log("Movendo o dataset para o calendário e conferindo invariantes…");
  const moved = psql(target, "begin; select count(*) from devseed.remap(); commit;");
  psql(target, "select devseed.expire_due(); select devseed.drain_outbox();");
  const checks = psql(target, "select check_name || ': ' || violations from devseed.check_invariants();").split("\n");
  const summary = psql(target, `select string_agg(label || ': ' || total, E'\\n') from (
    select 'vendas confirmadas' label, count(*) total from public.sales where status = 'CONFIRMED' and created_by in (select id from devseed.refs where kind = 'user')
    union all select 'vendas estornadas', count(*) from public.payment_attempts where status = 'REFUNDED'
    union all select 'dias com vendas', count(distinct (created_at at time zone 'America/Sao_Paulo')::date) from public.sales where status <> 'DRAFT'
    union all select 'reservas', count(*) from public.commercial_reservations
    union all select 'produtos', count(*) from public.products where sku like 'SEED-%' or slug like 'seed-%'
    union all select 'notificações', count(*) from public.notifications
    union all select 'operações puladas por falta de estoque ou recusadas pelo domínio (devseed.log)', count(*) from devseed.log where not ok) totals;`);
  psql(target, "insert into devseed.settings values ('done', now()::text);");
  console.log(`\n${summary}\nTabelas movidas no calendário: ${moved}\n\nInvariantes:\n${checks.map((line) => `  ${line}`).join("\n")}`);
  console.log(`\nConcluído em ${Math.round((Date.now() - started) / 1000)} s. Contas sintéticas: seed.<papel><nn>@institutojef.org.br, senha local SeedLocal123!`);
  if (checks.some((line) => !line.endsWith(": 0"))) process.exit(2);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
