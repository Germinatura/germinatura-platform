import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok", service: "pdv", version: "v2-foundation" });
}
