import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@germinatura/auth";
import { catalogCategorySchema } from "@germinatura/contracts";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CategoriesManager } from "@/components/admin/CategoriesManager";

export const dynamic = "force-dynamic";

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const user = await requireSession();
  if (!hasPermission(user, "catalog.manage")) redirect("/");
  const { after } = await searchParams;
  const cursor = z.uuid().safeParse(after);
  const client = await createSupabaseServerClient();
  let query = client.from("categories").select("id,name,slug,active,sort_order,revision").order("id").limit(51);
  if (cursor.success) query = query.gt("id", cursor.data);
  const { data, error } = await query;
  const parsed = z.array(catalogCategorySchema).safeParse(data?.map((row) => ({
    id: row.id, name: row.name, slug: row.slug, active: row.active, sortOrder: row.sort_order, revision: row.revision,
  })));
  const unavailable = Boolean(error || !parsed.success || (after && !cursor.success));
  const categories = parsed.success && !unavailable ? parsed.data.slice(0, 50) : [];
  const next = parsed.success && parsed.data.length > 50 ? categories.at(-1)?.id : undefined;
  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
    <div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
      <header>
        <Link href="/admin/catalogo" className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--g-brand-primary)]">Voltar ao catálogo</Link>
        <h1 className="text-3xl font-bold">Categorias</h1>
        <p className="mt-2 text-[var(--g-text-secondary)]">Organize os produtos e controle quais categorias ficam disponíveis.</p>
      </header>
      {unavailable ? <div role="alert" className="rounded-[var(--g-radius-card)] bg-[var(--g-status-danger-soft)] p-5">
        Não foi possível consultar as categorias. <Link href="/admin/catalogo/categorias" className="font-semibold underline">Tentar novamente</Link>
      </div> : <CategoriesManager categories={categories} />}
      <nav aria-label="Páginas de categorias" className="flex flex-wrap gap-4">
        {after && <Link href="/admin/catalogo/categorias" className="inline-flex min-h-11 items-center underline">Primeira página</Link>}
        {!unavailable && next && <Link href={`/admin/catalogo/categorias?after=${next}`} className="inline-flex min-h-11 items-center underline">Próxima página</Link>}
      </nav>
    </div>
  </div>;
}
