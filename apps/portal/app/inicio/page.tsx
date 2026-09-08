import { ConsumerHome } from "@/components/consumer/ConsumerHome";
import { requireSession } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function ConsumerHomePage() {
  const user = await requireSession();
  return <ConsumerHome user={user} />;
}
