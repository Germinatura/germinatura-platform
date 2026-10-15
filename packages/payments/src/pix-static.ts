// Static Pix BR Code (EMV® QRCPS Merchant-Presented Mode, as in the Banco Central "Manual de Padrões para Iniciação do
// Pix"). The system only builds the payload from the receiver configured for the environment; it never calls PicPay,
// never infers a payment from the code and never chooses a key. Confirmation stays manual.

export interface PixReceiver {
  /** Pix key of the receiving account (CPF, CNPJ, e-mail, +55 phone or random EVP key). */
  key: string;
  /** Receiver name as shown by the payer's bank: up to 25 characters, no accents. */
  merchantName: string;
  /** Receiver city: up to 15 characters, no accents. */
  merchantCity: string;
}

export type PixReceiverProblem = "MISSING" | "INVALID_KEY" | "INVALID_NAME" | "INVALID_CITY";

const onlyDigits = (value: string) => /^\d+$/.test(value);

function validCpf(value: string) {
  if (value.length !== 11 || !onlyDigits(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    const sum = [...value.slice(0, length)].reduce((total, char, index) => total + Number(char) * (length + 1 - index), 0);
    return ((sum * 10) % 11) % 10;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

function validCnpj(value: string) {
  if (value.length !== 14 || !onlyDigits(value) || /^(\d)\1{13}$/.test(value)) return false;
  const digit = (length: number) => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const rest = [...value.slice(0, length)].reduce((total, char, index) => total + Number(char) * weights[index], 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(12) === Number(value[12]) && digit(13) === Number(value[13]);
}

/** A Pix key in one of the formats of the DICT: CPF, CNPJ, e-mail, +55 phone or random (EVP) key. */
export function isValidPixKey(key: string) {
  if (key.length === 0 || key.length > 77 || key !== key.trim()) return false;
  if (onlyDigits(key)) return validCpf(key) || validCnpj(key);
  if (/^\+55\d{10,11}$/.test(key)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) return true;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(key);
}

/** Upper-case ASCII without accents, as the payer's bank shows it. */
export function pixText(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The receiver read from the environment, or the reason it cannot be used. Nothing is truncated or defaulted: a name
 * or city that does not fit is a configuration error, never a silently different receiver.
 */
export function readPixReceiver(env: { PICPAY_PIX_KEY?: string; PICPAY_PIX_MERCHANT_NAME?: string; PICPAY_PIX_MERCHANT_CITY?: string }):
  { receiver: PixReceiver; problem: null } | { receiver: null; problem: PixReceiverProblem } {
  const key = env.PICPAY_PIX_KEY?.trim() ?? "";
  const name = pixText(env.PICPAY_PIX_MERCHANT_NAME ?? "");
  const city = pixText(env.PICPAY_PIX_MERCHANT_CITY ?? "");
  if (!key || !env.PICPAY_PIX_MERCHANT_NAME?.trim() || !env.PICPAY_PIX_MERCHANT_CITY?.trim()) return { receiver: null, problem: "MISSING" };
  if (!isValidPixKey(key)) return { receiver: null, problem: "INVALID_KEY" };
  if (name.length === 0 || name.length > 25) return { receiver: null, problem: "INVALID_NAME" };
  if (city.length === 0 || city.length > 15) return { receiver: null, problem: "INVALID_CITY" };
  return { receiver: { key, merchantName: name, merchantCity: city }, problem: null };
}

/** The transaction id of a sale: "PDV" + the first 22 hex digits of its id (25 characters, nothing personal). */
export function pixTxidForSale(saleId: string) {
  const hex = saleId.replace(/-/g, "").toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(hex)) throw new Error("INVALID_SALE_ID");
  return `PDV${hex.slice(0, 22)}`;
}

/** CRC16/CCITT-FALSE (polynomial 0x1021, initial 0xFFFF), as the BR Code requires, in 4 upper-case hex digits. */
export function crc16(payload: string) {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function field(id: string, value: string) {
  if (value.length > 99) throw new Error("PIX_FIELD_TOO_LONG");
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

/**
 * The "Pix copia e cola" payload of a static charge with a fixed amount. The amount is integer cents (never a float);
 * the txid identifies the sale. Throws on an invalid receiver or amount: a wrong code is never produced.
 */
export function buildPixStaticPayload({ receiver, amountCents, txid }: { receiver: PixReceiver; amountCents: number; txid: string }) {
  if (!isValidPixKey(receiver.key)) throw new Error("INVALID_PIX_KEY");
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 99_999_999_999) throw new Error("INVALID_PIX_AMOUNT");
  if (!/^[A-Za-z0-9]{1,25}$/.test(txid)) throw new Error("INVALID_PIX_TXID");
  const name = pixText(receiver.merchantName);
  const city = pixText(receiver.merchantCity);
  if (!name || name.length > 25 || !city || city.length > 15) throw new Error("INVALID_PIX_RECEIVER");
  const amount = `${Math.floor(amountCents / 100)}.${(amountCents % 100).toString().padStart(2, "0")}`;
  const payload = [
    field("00", "01"),
    field("26", field("00", "br.gov.bcb.pix") + field("01", receiver.key)),
    field("52", "0000"),
    field("53", "986"),
    field("54", amount),
    field("58", "BR"),
    field("59", name),
    field("60", city),
    field("62", field("05", txid)),
  ].join("") + "6304";
  return payload + crc16(payload);
}
