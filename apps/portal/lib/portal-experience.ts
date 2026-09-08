// Navigation context only. Authorization always uses the authenticated roles.
export type PortalExperience = "consumer" | "admin";
export function experienceForPath(path: string): PortalExperience | null {
  if (path === "/" || path.startsWith("/admin/")) return "admin";
  if (["/inicio", "/catalogo", "/reservas", "/rifas"].includes(path)) return "consumer";
  return null;
}
export function experienceHome(experience: PortalExperience) {
  return experience === "admin" ? "/" : "/inicio";
}
