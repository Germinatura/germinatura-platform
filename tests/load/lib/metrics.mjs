// Per-route metrics: requests, outcome classes, latency percentiles, throughput and per-minute series (soak trend).
export class Metrics {
  constructor(name) {
    this.name = name;
    this.started = Date.now();
    this.finished = null;
    this.routes = new Map();
  }

  route(label) {
    if (!this.routes.has(label)) {
      this.routes.set(label, { label, requests: 0, ok: 0, expected4xx: 0, unexpected4xx: 0, server5xx: 0, network: 0, latencies: [], minutes: new Map() });
    }
    return this.routes.get(label);
  }

  record(label, status, elapsedMs, expected = []) {
    const route = this.route(label);
    route.requests += 1;
    route.latencies.push(elapsedMs);
    if (status === 0) route.network += 1;
    else if (status >= 500) route.server5xx += 1;
    else if (status >= 400) {
      if (expected.includes(status)) route.expected4xx += 1;
      else route.unexpected4xx += 1;
    } else route.ok += 1;
    const minute = Math.floor((Date.now() - this.started) / 60000);
    const bucket = route.minutes.get(minute) ?? { latencies: [], errors: 0 };
    bucket.latencies.push(elapsedMs);
    if (status === 0 || status >= 500) bucket.errors += 1;
    route.minutes.set(minute, bucket);
  }

  finish() {
    this.finished = Date.now();
    return this;
  }

  summary() {
    const durationSeconds = ((this.finished ?? Date.now()) - this.started) / 1000;
    const routes = [...this.routes.values()].map((route) => ({
      label: route.label,
      requests: route.requests,
      ok: route.ok,
      expected4xx: route.expected4xx,
      unexpected4xx: route.unexpected4xx,
      server5xx: route.server5xx,
      network: route.network,
      p50: percentile(route.latencies, 50),
      p95: percentile(route.latencies, 95),
      p99: percentile(route.latencies, 99),
      max: route.latencies.length ? Math.max(...route.latencies) : null,
      throughputPerSecond: round(route.requests / Math.max(durationSeconds, 1)),
      minutes: [...route.minutes.entries()].sort(([left], [right]) => left - right)
        .map(([minute, bucket]) => ({ minute, requests: bucket.latencies.length, p95: percentile(bucket.latencies, 95), errors: bucket.errors })),
    }));
    return { scenario: this.name, startedAt: new Date(this.started).toISOString(), durationSeconds: round(durationSeconds), routes };
  }
}

export function percentile(values, rank) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]);
}

// Least-squares slope of the per-minute p95 (ms per minute): a clearly positive slope means latency is creeping up.
export function trend(points) {
  const usable = points.filter((point) => point.p95 !== null);
  if (usable.length < 3) return null;
  const n = usable.length;
  const meanX = usable.reduce((sum, point) => sum + point.minute, 0) / n;
  const meanY = usable.reduce((sum, point) => sum + point.p95, 0) / n;
  const numerator = usable.reduce((sum, point) => sum + (point.minute - meanX) * (point.p95 - meanY), 0);
  const denominator = usable.reduce((sum, point) => sum + (point.minute - meanX) ** 2, 0);
  return denominator === 0 ? 0 : round(numerator / denominator);
}

const round = (value) => Math.round(value * 100) / 100;
