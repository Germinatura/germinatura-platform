import { brandSvg } from "@germinatura/ui/brand";

export function GET() {
  return new Response(brandSvg(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
}
