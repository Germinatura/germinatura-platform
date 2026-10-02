// Fail-closed target check: the harness only ever talks to the Germinatura STAGING deployment.
// Production hosts, custom domains and anything not on this allowlist abort the run before any request.
export const STAGING_HOSTS = Object.freeze({
  portal: "germinatura-portal-staging.germinatura.workers.dev",
  pdv: "germinatura-pdv-staging.germinatura.workers.dev",
  jobs: "germinatura-jobs-staging.germinatura.workers.dev",
});

export function stagingTarget(env = process.env) {
  if (env.LOAD_TARGET !== "staging") throw new Error("LOAD_TARGET=staging é obrigatório.");
  const urls = {
    portal: env.LOAD_PORTAL_URL ?? `https://${STAGING_HOSTS.portal}`,
    pdv: env.LOAD_PDV_URL ?? `https://${STAGING_HOSTS.pdv}`,
    jobs: env.LOAD_JOBS_URL ?? `https://${STAGING_HOSTS.jobs}`,
  };
  for (const [name, value] of Object.entries(urls)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== STAGING_HOSTS[name] || url.pathname !== "/" || url.search) {
      throw new Error(`Alvo ${name} recusado: só ${STAGING_HOSTS[name]} é aceito.`);
    }
    urls[name] = url.origin;
  }
  const projectRef = env.LOAD_SUPABASE_PROJECT_ID;
  const supabaseUrl = env.LOAD_SUPABASE_URL;
  if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) throw new Error("Projeto Supabase de staging ausente.");
  if (!supabaseUrl || new URL(supabaseUrl).hostname !== `${projectRef}.supabase.co`) throw new Error("A URL do Supabase não corresponde ao projeto de staging informado.");
  if (env.LOAD_PRODUCTION_SUPABASE_PROJECT_ID && env.LOAD_PRODUCTION_SUPABASE_PROJECT_ID === projectRef) throw new Error("O projeto informado é o de produção.");
  if (!env.LOAD_SUPABASE_ACCESS_TOKEN) throw new Error("Credencial de gestão do Supabase ausente.");
  return { ...urls, projectRef, supabaseUrl, accessToken: env.LOAD_SUPABASE_ACCESS_TOKEN };
}
