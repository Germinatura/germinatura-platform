import { appIconSvg } from "@germinatura/ui/brand";

export function GET() {
  // The offline shell is the PDV: its own variant of the mark (operation.primary on the dark surface).
  return new Response(appIconSvg("pdv", "rounded"), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" } });
}
