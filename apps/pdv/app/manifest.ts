import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: "PDV Germinatura", short_name: "Germinatura",
    description: "PDV com consulta de catálogo offline. Vendas exigem conexão.",
    lang: "pt-BR", start_url: "/", scope: "/", display: "standalone",
    background_color: "#070B18", theme_color: "#070B18",
    icons: [{ src: "/offline/brand.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
