import { hasPermission } from "@germinatura/auth";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { UsersManager } from "@/components/admin/UsersManager";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await requireSession();
  if (!hasPermission(user, "users.manage")) redirect("/");
  return <UsersManager />;
}
