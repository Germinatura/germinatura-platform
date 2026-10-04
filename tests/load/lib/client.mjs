// A virtual user: its own cookie jar (one session per user, like a browser) and every request timed into Metrics.
export class VirtualUser {
  constructor(origin, metrics) {
    this.origin = origin;
    this.metrics = metrics;
    this.cookies = new Map();
  }

  headers(extra = {}) {
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    return { Origin: this.origin, "Sec-Fetch-Site": "same-origin", Accept: "application/json, text/html", ...(cookie ? { Cookie: cookie } : {}), ...extra };
  }

  keepCookies(response) {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(header) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** Times one request. `expected` lists 4xx statuses that are a correct outcome for this call (not failures). */
  async request(label, method, path, { body, headers = {}, expected = [], timeoutMs = 30000 } = {}) {
    const started = performance.now();
    let status = 0;
    let payload = null;
    let sample = null;
    try {
      const response = await fetch(`${this.origin}${path}`, {
        method,
        headers: this.headers({ ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      this.keepCookies(response);
      const text = await response.text();
      if (status >= 400) sample = { ray: response.headers.get("cf-ray"), contentType: response.headers.get("content-type"), body: text.replace(/\s+/g, " ").slice(0, 300) };
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        try { payload = JSON.parse(text); } catch { payload = null; }
      }
    } catch (error) {
      status = 0;
      sample = { error: error instanceof Error ? error.name : "error" };
    }
    this.metrics?.record(label, status, performance.now() - started, expected, sample);
    return { status, body: payload };
  }

  async login(identifier, password) {
    const result = await this.request("auth.login", "POST", "/api/auth/login", { body: { identifier, password } });
    if (result.status !== 200) throw new Error(`Login recusado para um usuário de carga (${result.status}).`);
    return result;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const think = (min, max) => sleep(min + Math.random() * (max - min));
