import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { ConsumerCatalog } from "@/components/catalog/ConsumerCatalog";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const user = await requireSession();
  if (!hasPermission(user, "catalog.read")) redirect("/");

  return <ConsumerCatalog />;
}
