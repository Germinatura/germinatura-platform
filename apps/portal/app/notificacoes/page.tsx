import { NotificationsCenter } from "@/components/notifications/NotificationsCenter";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requireSession();
  return <NotificationsCenter />;
}
