import { requireSession } from "@/lib/auth";
import { AdminOverview } from "@/components/admin/AdminOverview";
import { ConsumerHome } from "@/components/consumer/ConsumerHome";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const user = await requireSession();
  return user.roles.includes("ADMIN") ? <AdminOverview name={user.name} /> : <ConsumerHome />;
}
