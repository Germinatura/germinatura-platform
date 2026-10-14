import type { MetadataRoute } from "next";
import { appBrand, appManifestIcons } from "@germinatura/ui/brand";

const brand = appBrand.portal;

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: brand.name, short_name: brand.shortName,
    description: "Portal institucional da comunidade Germinatura",
    lang: "pt-BR", start_url: "/", scope: "/", display: "standalone",
    background_color: brand.background, theme_color: brand.theme,
    icons: [...appManifestIcons],
  };
}
