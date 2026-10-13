import type { MetadataRoute } from "next";
import { appBrand, appManifestIcons } from "@germinatura/ui/brand";

const brand = appBrand.pdv;

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: brand.name, short_name: brand.shortName,
    description: "PDV com consulta de catálogo offline. Vendas exigem conexão.",
    lang: "pt-BR", start_url: "/", scope: "/", display: "standalone",
    background_color: brand.background, theme_color: brand.theme,
    icons: [...appManifestIcons],
  };
}
