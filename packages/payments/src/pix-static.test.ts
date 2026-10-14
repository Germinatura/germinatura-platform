import { describe, expect, it } from "vitest";
import { buildPixStaticPayload, crc16, isValidPixKey, pixText, pixTxidForSale, readPixReceiver } from "./pix-static";

// Fictitious receiver for tests only (a random EVP key from the Banco Central manual's example).
const receiver = { key: "123e4567-e12b-12d1-a456-426655440000", merchantName: "Fulano de Tal", merchantCity: "Brasília" };

/** Reads the top-level TLV fields of a payload. */
function fields(payload: string) {
  const result = new Map<string, string>();
  let index = 0;
  while (index < payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    result.set(id, payload.slice(index + 4, index + 4 + length));
    index += 4 + length;
  }
  return result;
}

describe("static Pix BR Code", () => {
  it("computes the CRC16 of the Banco Central manual example", () => {
    const example = "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304";
    expect(crc16(example)).toBe("1D3D");
  });

  it("builds a valid payload with the amount in reais, the receiver and the sale's txid", () => {
    const txid = pixTxidForSale("71000000-0000-4000-8000-000000000001");
    const payload = buildPixStaticPayload({ receiver, amountCents: 2615, txid });
    const top = fields(payload);
    expect(top.get("00")).toBe("01");
    expect(fields(top.get("26") ?? "")).toEqual(new Map([["00", "br.gov.bcb.pix"], ["01", receiver.key]]));
    expect(top.get("52")).toBe("0000");
    expect(top.get("53")).toBe("986");
    expect(top.get("54")).toBe("26.15");
    expect(top.get("58")).toBe("BR");
    expect(top.get("59")).toBe("FULANO DE TAL");
    expect(top.get("60")).toBe("BRASILIA");
    expect(fields(top.get("62") ?? "").get("05")).toBe(txid);
    expect(payload.slice(-8, -4)).toBe("6304");
    expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
  });

  it("is deterministic per amount and changes when the amount changes", () => {
    const txid = pixTxidForSale("71000000-0000-4000-8000-000000000001");
    const first = buildPixStaticPayload({ receiver, amountCents: 2590, txid });
    expect(buildPixStaticPayload({ receiver, amountCents: 2590, txid })).toBe(first);
    const withSurcharge = buildPixStaticPayload({ receiver, amountCents: 2615, txid });
    expect(withSurcharge).not.toBe(first);
    expect(fields(first).get("54")).toBe("25.90");
    expect(fields(buildPixStaticPayload({ receiver, amountCents: 5, txid })).get("54")).toBe("0.05");
    expect(fields(buildPixStaticPayload({ receiver, amountCents: 100_000, txid })).get("54")).toBe("1000.00");
  });

  it("derives a 25-character txid from the sale without the whole id or anything personal", () => {
    const txid = pixTxidForSale("1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d");
    expect(txid).toBe("PDV1A2B3C4D5E6F4A1B8C2D3E");
    expect(txid).toHaveLength(25);
    expect(() => pixTxidForSale("not-a-sale")).toThrow("INVALID_SALE_ID");
  });

  it("never builds a payload from an invalid amount, key, receiver or txid", () => {
    const txid = "PDVTEST";
    expect(() => buildPixStaticPayload({ receiver, amountCents: 0, txid })).toThrow("INVALID_PIX_AMOUNT");
    expect(() => buildPixStaticPayload({ receiver, amountCents: 12.5, txid })).toThrow("INVALID_PIX_AMOUNT");
    expect(() => buildPixStaticPayload({ receiver: { ...receiver, key: "chave errada" }, amountCents: 100, txid })).toThrow("INVALID_PIX_KEY");
    expect(() => buildPixStaticPayload({ receiver: { ...receiver, merchantCity: "Cidade Muito Longa Demais" }, amountCents: 100, txid })).toThrow("INVALID_PIX_RECEIVER");
    expect(() => buildPixStaticPayload({ receiver, amountCents: 100, txid: "PDV-1" })).toThrow("INVALID_PIX_TXID");
  });

  it("accepts only Pix key formats of the DICT", () => {
    expect(isValidPixKey("123e4567-e12b-12d1-a456-426655440000")).toBe(true);
    expect(isValidPixKey("pagamentos@empresa-exemplo.com.br")).toBe(true);
    expect(isValidPixKey("+5511987654321")).toBe(true);
    expect(isValidPixKey("11222333000181")).toBe(true); // CNPJ with valid check digits (fictitious)
    expect(isValidPixKey("52998224725")).toBe(true); // CPF with valid check digits (fictitious)
    expect(isValidPixKey("11222333000182")).toBe(false);
    expect(isValidPixKey("11111111111")).toBe(false);
    expect(isValidPixKey("11987654321")).toBe(false); // phone without +55
    expect(isValidPixKey(" pagamentos@empresa.com")).toBe(false);
    expect(isValidPixKey("")).toBe(false);
  });

  it("reads the receiver from the environment and fails closed when anything is missing or invalid", () => {
    const env = { PICPAY_PIX_KEY: receiver.key, PICPAY_PIX_MERCHANT_NAME: "Comissão Formatura", PICPAY_PIX_MERCHANT_CITY: "São Paulo" };
    expect(readPixReceiver(env)).toEqual({ receiver: { key: receiver.key, merchantName: "COMISSAO FORMATURA", merchantCity: "SAO PAULO" }, problem: null });
    expect(readPixReceiver({})).toEqual({ receiver: null, problem: "MISSING" });
    expect(readPixReceiver({ ...env, PICPAY_PIX_KEY: " " })).toEqual({ receiver: null, problem: "MISSING" });
    expect(readPixReceiver({ ...env, PICPAY_PIX_MERCHANT_CITY: undefined })).toEqual({ receiver: null, problem: "MISSING" });
    expect(readPixReceiver({ ...env, PICPAY_PIX_KEY: "não é chave" })).toEqual({ receiver: null, problem: "INVALID_KEY" });
    expect(readPixReceiver({ ...env, PICPAY_PIX_MERCHANT_NAME: "Nome comprido demais para o Pix" })).toEqual({ receiver: null, problem: "INVALID_NAME" });
    expect(readPixReceiver({ ...env, PICPAY_PIX_MERCHANT_CITY: "Cidade comprida demais" })).toEqual({ receiver: null, problem: "INVALID_CITY" });
    expect(pixText("  Comissão   de Formatura! ")).toBe("COMISSAO DE FORMATURA");
  });
});
