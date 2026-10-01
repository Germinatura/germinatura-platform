import type { FinanceAccount, FinanceCategory } from "@germinatura/contracts";

export const financeCategoryLabels: Record<FinanceCategory, string> = {
  VENDA_PDV: "Venda PDV", VENDA_ONLINE: "Venda online", RESERVA: "Reserva", RIFA: "Rifa", EVENTO: "Evento",
  FORNECEDOR: "Fornecedor", TAXAS: "Taxas", MENSALIDADES: "Mensalidades", TRANSPORTE: "Transporte",
  MATERIAIS: "Materiais", REEMBOLSO: "Reembolso", AJUSTE: "Ajuste", OUTROS: "Outros",
};

export const financeAccountLabels: Record<FinanceAccount, string> = {
  PICPAY_EMPRESAS: "PicPay Empresas", DINHEIRO_FISICO: "Dinheiro físico",
  RECEBIVEIS_PICPAY: "Recebíveis PicPay", PENDENTE_LIQUIDACAO: "Pendente de liquidação", COFRINHO_PICPAY: "Cofrinho PicPay",
};
