import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

function local() {
  const output = execFileSync(process.execPath, ["tools/run-supabase.mjs", "status", "-o", "env"], { encoding: "utf8" });
  const url = output.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key = output.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if (!url || !key || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("Supabase local indisponível");
  return { url, key };
}

const salesHeader = "Data e hora da venda;Previsão de pagamento;Bandeira;Número do cartão;Forma de pagamento;Solução de captura;Valor da venda;"
  + "Valor recebido comissão;Valor cancelado;Tarifa;Custo fixo;Taxa de parcelamento;Valor Líquido;Quantidade de parcelas;Status;NSU;"
  + "Número do terminal;TID;Código de autorização;Número do pedido;Número único da transação;Pagador Picpay;Nome do comprador;Documento;"
  + "Email;Telefone;Transação recorrente;Split;CNPJ parceiro;Valor bruto pago parceiro;Transação 3DS;ARN;";
const brl = (cents: number) => `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
const dot = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

// Synthetic files dated in the past, with amounts unique to the run: no opening position is recorded here.
it("serializa importações concorrentes: exportações sobrepostas não duplicam movimentos e o mesmo arquivo entra uma vez", async () => {
  const { url, key } = local();
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin.teste@institutojef.org.br", password: "Admin123!" }) });
  const token = (await login.json() as { access_token?: string }).access_token;
  expect(login.ok && token).toBeTruthy();
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function rpc(name: string, input: Record<string, unknown>) {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  const base = 100_000 + Math.floor(Math.random() * 800_000);
  const line = (day: string, movement: string, description: string, cents: number) =>
    `${day};${movement};${description};${cents > 0 ? "Entrada" : "Saída"};${dot(cents)};`;
  const shared = [line("2025-03-10", "Pix recebido", "Cliente Corrida", base), line("2025-03-10", "Pix recebido", "Cliente Corrida", base)];
  const fileA = ["data;movimento;descrição;tipo;valor", ...shared, line("2025-03-11", "Pix enviado", "Fornecedor A", -(base + 1))].join("\r\n");
  const fileB = ["data;movimento;descrição;tipo;valor", ...shared, line("2025-03-09", "Pix enviado", "Fornecedor B", -(base + 2))].join("\r\n");
  const [a, b] = await Promise.all([
    rpc("import_picpay_file", { p_file_name: "extrato-a.csv", p_content: fileA, p_idempotency_key: `picpay-race-a:${randomUUID()}`, p_correlation_id: randomUUID() }),
    rpc("import_picpay_file", { p_file_name: "extrato-b.csv", p_content: fileB, p_idempotency_key: `picpay-race-b:${randomUUID()}`, p_correlation_id: randomUUID() }),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  // Whatever ran first, the two identical movements exist twice in total, never four times.
  expect(Number(a.data.new_count) + Number(b.data.new_count)).toBe(4);
  expect([Number(a.data.known_count), Number(b.data.known_count)].sort()).toEqual([0, 2]);

  const sales = [salesHeader,
    `10/03/2025 10:00:00;10/03/2025;Pix;;Pix;QR Code PicPay;${brl(base + 3)};;R$ 0,00; R$ 0,00; R$ 0,00;;${brl(base + 3)};1;Aprovada;;;;;;`
      + `E${String(base).padStart(31, "0")};-;-;-;-;-;-;-;-;-;-;-;`].join("\n");
  const [s1, s2] = await Promise.all([1, 2].map((n) => rpc("import_picpay_file", {
    p_file_name: `vendas-${n}.csv`, p_content: sales, p_idempotency_key: `picpay-race-sales-${n}:${randomUUID()}`, p_correlation_id: randomUUID(),
  })));
  expect([s1.status, s2.status].sort()).toEqual([200, 400]);
  expect((s1.status === 400 ? s1 : s2).data.message).toBe("PICPAY_FILE_ALREADY_IMPORTED");
  const transactions = await rpc("list_picpay_transactions", { p_from: "2025-03-10", p_to: "2025-03-10", p_status: null, p_unlinked_only: false, p_limit: 500 });
  expect((transactions.data as unknown as Array<{ transaction_ref: string }>).filter((item) => item.transaction_ref === `E${String(base).padStart(31, "0")}`)).toHaveLength(1);
});
