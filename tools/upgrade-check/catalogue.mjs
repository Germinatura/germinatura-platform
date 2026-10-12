// Catalogue rows (permissions and their role grants) that migrations after the upgrade base add. A check expects
// exactly the rows of the migrations it actually applied — read back from supabase_migrations, by migration name so a
// re-timed file keeps its expectation — never the rows of a migration it did not apply. The rollback check stops at
// Phase 5 (20261023090000) and so expects only the cohort catalogue; the full upgrade check also expects PR D.
//
// grants: the role keys granted the permission in role_permissions. ADMIN_MASTER is not a role row: it holds every
// permission through its global semantics (admin_masters + has_permission), so it never appears here.
export const CATALOGUE_ADDITIONS = Object.freeze({
  cohort_authorization: Object.freeze({ "cohorts.manage": Object.freeze([]) }),
  payment_surcharges: Object.freeze({ "sales.surcharge.waive": Object.freeze(["ADMIN"]) }),
});

/** The permissions and grants expected from the applied migration names (unknown names add nothing). */
export function expectedCatalogue(appliedNames) {
  const permissions = {};
  for (const name of appliedNames) {
    for (const [permission, roles] of Object.entries(CATALOGUE_ADDITIONS[name] ?? {})) permissions[permission] = [...roles].sort();
  }
  const keys = Object.keys(permissions).sort();
  return {
    permissions,
    expectedNewRows: {
      permissions: keys.length,
      role_permissions: keys.reduce((total, key) => total + permissions[key].length, 0),
    },
  };
}

/**
 * Compares the expected catalogue with what the database holds: each expected permission exists exactly once and is
 * granted to exactly the expected roles (no accidental grant to VENDEDOR, FINANCEIRO or any other role).
 * `actual` maps permission key → { count, roles }.
 */
export function catalogueProblems(expected, actual) {
  const problems = [];
  for (const [permission, roles] of Object.entries(expected.permissions)) {
    const found = actual[permission];
    if (!found || found.count !== 1) problems.push(`catálogo: ${permission} existe ${found?.count ?? 0} vez(es), esperado 1`);
    const granted = [...(found?.roles ?? [])].sort();
    if (JSON.stringify(granted) !== JSON.stringify(roles)) {
      problems.push(`catálogo: ${permission} concedida a [${granted.join(", ")}], esperado [${roles.join(", ")}]`);
    }
  }
  return problems;
}
