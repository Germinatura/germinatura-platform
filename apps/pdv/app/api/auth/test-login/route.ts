import { institutionalEmailSchema } from "@germinatura/contracts";
import { NextResponse } from "next/server";
import { createPdvSupabaseServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (process.env.NODE_ENV === "production" || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = institutionalEmailSchema.safeParse(body?.email);
  if (!email.success || typeof body?.password !== "string" || body.password.length > 128) {
    return NextResponse.json({ code: "INVALID_FIXTURE" }, { status: 422 });
  }
  const client = await createPdvSupabaseServerClient();
  const { error } = await client.auth.signInWithPassword({ email: email.data, password: body.password });
  if (error) return NextResponse.json({ code: "INVALID_FIXTURE" }, { status: 401 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
