// SQL against the staging database through the Supabase Management API (the token never leaves the runner's env).
// Used only to prepare the run's isolated fixtures and to check invariants; the load itself goes through the apps.
export function stagingSql(target) {
  return async function sql(query) {
    const response = await fetch(`https://api.supabase.com/v1/projects/${target.projectRef}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`SQL de staging falhou (${response.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : [];
  };
}

export const literal = (value) => value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
