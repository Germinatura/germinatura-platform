"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Field, Input, InputGroup, fieldDescriptionIds } from "@germinatura/ui";
import { FilterShell, type ActiveFilter } from "@germinatura/ui/filters";
import {
  catalogChannelLabels, catalogFiltersQuery, catalogStatusLabels, emptyCatalogFilters, priceBound,
  type CatalogChannelFilter, type CatalogFilterValues, type CatalogStatusFilter,
} from "@/lib/catalog-filters";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
// A bound being typed ("15,") is not an error yet.
const priceError = (value: string) => priceBound(value).invalid && !/[,.]$/.test(value.trim()) ? "Use um valor em reais, como 15 ou 15,50." : undefined;

/**
 * Search and filters of the admin catalog. The URL is the state: the server reads it and filters the whole catalog, so
 * a link or a reload shows the same list. Changes reach the URL after a short pause, so typing a price is not a request
 * per key.
 */
export function CatalogFilters({ initial, categories, shown, total }: { initial: CatalogFilterValues; categories: { id: string; name: string }[]; shown: number; total: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState(initial);
  const [pending, startTransition] = useTransition();
  const pushed = useRef(catalogFiltersQuery(initial));

  useEffect(() => {
    const query = catalogFiltersQuery(filters);
    if (query === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = query;
      startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    }, 350);
    return () => clearTimeout(timer);
  }, [filters, pathname, router]);

  function update(patch: Partial<CatalogFilterValues>) { setFilters((current) => ({ ...current, ...patch })); }

  const categoryName = (id: string) => categories.find((category) => category.id === id)?.name ?? "selecionada";
  const min = priceBound(filters.min);
  const max = priceBound(filters.max);
  const chips: ActiveFilter[] = [];
  if (filters.q) chips.push({ key: "q", label: `Busca: ${filters.q}`, onRemove: () => update({ q: "" }) });
  if (filters.category) chips.push({ key: "category", label: `Categoria: ${categoryName(filters.category)}`, onRemove: () => update({ category: "" }) });
  if (filters.status !== "ALL") chips.push({ key: "status", label: catalogStatusLabels[filters.status], onRemove: () => update({ status: "ALL" }) });
  if (filters.channel !== "ALL") chips.push({ key: "channel", label: catalogChannelLabels[filters.channel], onRemove: () => update({ channel: "ALL" }) });
  if (min.cents !== null) chips.push({ key: "min", label: `Preço a partir de ${brl.format(min.cents / 100)}`, onRemove: () => update({ min: "" }) });
  if (max.cents !== null) chips.push({ key: "max", label: `Preço até ${brl.format(max.cents / 100)}`, onRemove: () => update({ max: "" }) });

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="text-lg font-bold">Localizar produto</h2><p className="mt-1 text-sm text-[var(--g-text-secondary)]" aria-live="polite">{pending ? "Filtrando…" : `${shown} de ${total} produtos`}</p></div>
        <label className="block w-full min-w-0 sm:max-w-md"><span className="sr-only">Buscar produto</span><InputGroup icon={<Search />}><Input value={filters.q} maxLength={120} onChange={(event) => update({ q: event.target.value })} placeholder="Nome, SKU ou categoria" /></InputGroup></label>
      </div>
      <FilterShell
        value={filters}
        emptyValue={{ ...emptyCatalogFilters, q: filters.q }}
        onChange={setFilters}
        activeFilters={chips}
        activeCount={chips.filter((chip) => chip.key !== "q").length}
        onClearAll={() => setFilters(emptyCatalogFilters)}
        title="Filtros do catálogo"
      >
        {(values, set) => {
          const minError = priceError(values.min);
          const maxError = priceError(values.max);
          return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            <Field id="catalog-filter-category" label="Categoria"><select id="catalog-filter-category" className="g-input" value={values.category} onChange={(event) => set({ category: event.target.value })}><option value="">Todas</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
            <Field id="catalog-filter-status" label="Situação"><select id="catalog-filter-status" className="g-input" value={values.status} onChange={(event) => set({ status: event.target.value as CatalogStatusFilter })}><option value="ALL">Todos</option><option value="ACTIVE">Ativos</option><option value="INACTIVE">Inativos</option></select></Field>
            <Field id="catalog-filter-channel" label="Canal"><select id="catalog-filter-channel" className="g-input" value={values.channel} onChange={(event) => set({ channel: event.target.value as CatalogChannelFilter })}><option value="ALL">Todos</option>{(Object.keys(catalogChannelLabels) as Exclude<CatalogChannelFilter, "ALL">[]).map((channel) => <option key={channel} value={channel}>{catalogChannelLabels[channel]}</option>)}</select></Field>
            <Field id="catalog-filter-min" label="Preço mínimo (R$)" error={minError}><Input id="catalog-filter-min" inputMode="decimal" maxLength={20} value={values.min} aria-invalid={Boolean(minError) || undefined} aria-describedby={fieldDescriptionIds("catalog-filter-min", { error: minError })} onChange={(event) => set({ min: event.target.value })} /></Field>
            <Field id="catalog-filter-max" label="Preço máximo (R$)" error={maxError}><Input id="catalog-filter-max" inputMode="decimal" maxLength={20} value={values.max} aria-invalid={Boolean(maxError) || undefined} aria-describedby={fieldDescriptionIds("catalog-filter-max", { error: maxError })} onChange={(event) => set({ max: event.target.value })} /></Field>
          </div>;
        }}
      </FilterShell>
    </div>
  );
}
