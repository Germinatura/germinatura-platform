import { redirect } from "next/navigation";

// The statement import became part of the PicPay reconciliation (Minhas vendas, Recebíveis and Extrato).
export default function StatementImportPage() {
  redirect("/admin/financeiro/conciliacao-picpay");
}
