// Browser API client: same-origin cookie session; JSON in and out.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    headers["Content-Type"] = "application/gzip";
    payload = body as BodyInit;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else if (method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    payload = "{}";
  }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload, credentials: "same-origin" });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? res.statusText, e.details, e.requestId);
  }
  return json as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});

/** Fetch on mount and when deps change; `reload` re-fetches without flashing the old data away. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e as ApiError);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Server-Sent Events for a job or project; calls onEvent for every event (resumes with Last-Event-ID). */
export function useEvents(query: { job?: string; project?: string } | null, onEvent: (e: { type: string; data: any }) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = query ? `${query.job ?? ""}|${query.project ?? ""}` : "";
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!query) return;
    const qs = new URLSearchParams();
    if (query.job) qs.set("job", query.job);
    if (query.project) qs.set("project", query.project);
    const es = new EventSource(`/api/v1/events?${qs}`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const types = ["JOB_QUEUED", "JOB_STARTED", "TEST_STARTED", "TEST_COMPLETED", "TEST_FAILED", "COVERAGE_UPDATED", "JOB_COMPLETED"];
    const h = (ev: MessageEvent) => {
      try {
        cb.current({ type: (ev as MessageEvent & { type: string }).type, data: JSON.parse(ev.data) });
      } catch {
        /* ignore malformed */
      }
    };
    for (const t of types) es.addEventListener(t, h);
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return connected;
}

// ------------------------------------------------------------------ formatting
export type Cov = Record<string, { covered: number; total: number }>;
export const pct = (c?: { covered: number; total: number } | null) => (c && c.total > 0 ? (100 * c.covered) / c.total : null);
export const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
export function fmtDuration(ms?: number | null) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
export function fmtBytes(n?: number | null) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
export function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString();
}
export const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "ERROR"];
