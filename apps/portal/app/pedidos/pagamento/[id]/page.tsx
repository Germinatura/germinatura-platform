import { notFound } from "next/navigation";
import { PaymentLinkTracker } from "@/components/reservations/PaymentLinkTracker";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string }>; }

/** ADR 0010: the page PicPay returns the customer to; it only reflects what the server knows. */
export default async function OnlinePaymentPage({ params }: PageProps) {
  await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header>
      <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Pedidos</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Pagamento online</h1>
    </header>
    <PaymentLinkTracker chargeId={id} />
  </div></div>;
}
