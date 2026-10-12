// Prometheus text-format metrics (no external dependency).

type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());
const fmt = (l: Labels) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
};

export class Counter {
  private v = new Map<string, [Labels, number]>();
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Labels = {}, n = 1) {
    const k = key(l);
    const cur = this.v.get(k);
    this.v.set(k, [l, (cur?.[1] ?? 0) + n]);
  }
  get(l: Labels = {}) {
    return this.v.get(key(l))?.[1] ?? 0;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [l, n] of this.v.values()) lines.push(`${this.name}${fmt(l)} ${n}`);
    if (this.v.size === 0) lines.push(`${this.name} 0`);
    return lines.join("\n");
  }
}

export class Gauge {
  private v = new Map<string, [Labels, number | (() => number)]>();
  constructor(readonly name: string, readonly help: string) {}
  set(value: number | (() => number), l: Labels = {}) {
    this.v.set(key(l), [l, value]);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [l, n] of this.v.values()) lines.push(`${this.name}${fmt(l)} ${typeof n === "function" ? n() : n}`);
    return lines.join("\n");
  }
}

export class Histogram {
  private v = new Map<string, { l: Labels; counts: number[]; sum: number; n: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}
  observe(x: number, l: Labels = {}) {
    const k = key(l);
    let h = this.v.get(k);
    if (!h) this.v.set(k, (h = { l, counts: this.buckets.map(() => 0), sum: 0, n: 0 }));
    this.buckets.forEach((b, i) => {
      if (x <= b) h!.counts[i]!++;
    });
    h.sum += x;
    h.n++;
  }
  count(l: Labels = {}) {
    return this.v.get(key(l))?.n ?? 0;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const h of this.v.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${fmt({ ...h.l, le: String(b) })} ${h.counts[i]}`));
      lines.push(`${this.name}_bucket${fmt({ ...h.l, le: "+Inf" })} ${h.n}`);
      lines.push(`${this.name}_sum${fmt(h.l)} ${h.sum}`);
      lines.push(`${this.name}_count${fmt(h.l)} ${h.n}`);
    }
    return lines.join("\n");
  }
}

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LONG = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];

export class Metrics {
  readonly apiRequests = new Counter("api_requests_total", "API requests by route and status");
  readonly apiLatency = new Histogram("api_request_latency_seconds", "API request latency", SECONDS);
  readonly queueDepth = new Gauge("queue_depth", "Tasks waiting for a worker");
  readonly jobsTotal = new Counter("jobs_total", "Jobs created by trigger");
  readonly jobsFailed = new Counter("jobs_failed_total", "Jobs finished in a non-successful state, by state");
  readonly jobsRunning = new Gauge("jobs_running", "Jobs currently running");
  readonly tasksTotal = new Counter("tasks_finished_total", "Tasks finished by kind and state");
  readonly workerHeartbeats = new Counter("worker_heartbeats_total", "Worker heartbeats received");
  readonly workersOnline = new Gauge("workers_online", "Workers with a heartbeat in the last minute");
  readonly simulationDuration = new Histogram("simulation_duration_seconds", "Duration of test runs", LONG);
  readonly buildDuration = new Histogram("build_duration_seconds", "Duration of builds (compile)", LONG);
  readonly schedulingLatency = new Histogram("scheduling_latency_seconds", "Time from task queued to claimed", [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300]);
  readonly testPassRate = new Gauge("test_pass_rate", "Pass rate of test runs finished in the last hour (0-1)");
  readonly coverage = new Gauge("coverage_percent", "Latest merged coverage of a project by metric");
  readonly artifactBytes = new Counter("artifact_bytes_total", "Bytes stored as artifacts by kind");
  readonly aiLatency = new Histogram("ai_analysis_latency_seconds", "AI analysis latency by provider", [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120]);
  readonly aiFailures = new Counter("ai_analysis_failures_total", "Failed AI analyses by provider and reason");
  readonly buildCache = new Counter("build_cache_lookups_total", "Build cache lookups by result (hit|miss)");
  readonly leaseExpired = new Counter("lease_expirations_total", "Task leases that expired (lost worker)");
  readonly staleReports = new Counter("stale_task_reports_total", "Worker reports rejected because the lease token was stale");
  readonly uploadsRejected = new Counter("artifact_uploads_rejected_busy_total", "Artifact uploads refused with 503 because the upload memory budget was in use");
  readonly webhooks = new Counter("webhook_deliveries_total", "Webhook deliveries by provider and result");
  readonly rateLimited = new Counter("rate_limited_total", "Requests refused by rate limiting");
  readonly notifications = new Counter("notifications_total", "Notification deliveries by kind and result");
  readonly retentionDeleted = new Counter("retention_objects_deleted_total", "Objects deleted from storage by retention / GC");
  readonly processRss = new Gauge("process_resident_memory_bytes", "Resident set size");

  constructor() {
    this.processRss.set(() => process.memoryUsage().rss);
  }

  render() {
    return (
      [
        this.apiRequests, this.apiLatency, this.queueDepth, this.jobsTotal, this.jobsFailed, this.jobsRunning, this.tasksTotal,
        this.workerHeartbeats, this.workersOnline, this.simulationDuration, this.buildDuration, this.schedulingLatency,
        this.testPassRate, this.coverage, this.artifactBytes, this.aiLatency, this.aiFailures, this.buildCache, this.leaseExpired,
        this.staleReports, this.uploadsRejected, this.webhooks, this.rateLimited, this.notifications, this.retentionDeleted, this.processRss,
      ]
        .map((m) => m.render())
        .join("\n") + "\n"
    );
  }
}
