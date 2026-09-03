import { Card } from "@germinatura/ui";

export default function LoadingRaffles() {
  return <div role="status" aria-label="Carregando campanhas de rifas" aria-busy="true" className="mx-auto max-w-[var(--g-content-standard)] space-y-6 px-4 py-8 sm:px-6">
    <span className="sr-only">Carregando campanhas de rifas</span>
    {[0, 1, 2].map((item) => <Card key={item} className="space-y-4 p-6" aria-hidden="true">
      <div className="h-6 w-1/2 animate-pulse rounded bg-[var(--g-surface-subtle)]" />
      <div className="h-20 animate-pulse rounded bg-[var(--g-surface-subtle)]" />
    </Card>)}
  </div>;
}
