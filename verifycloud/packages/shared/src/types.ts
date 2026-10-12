// Domain vocabulary shared by API, worker, CLI and web.

export const JOB_STATES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES: readonly JobState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED"];

/** State of one unit of work (build or test run) inside a job. */
export const TASK_STATES = ["BLOCKED", "QUEUED", "RUNNING", "PASSED", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "SKIPPED"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["PASSED", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "RESOURCE_EXCEEDED", "SKIPPED"];

export type TaskKind = "build" | "test";
export type Role = "owner" | "admin" | "engineer" | "viewer";
export const ROLES: readonly Role[] = ["viewer", "engineer", "admin", "owner"];
export const roleAtLeast = (have: Role, need: Role) => ROLES.indexOf(have) >= ROLES.indexOf(need);

export type JobTrigger = "manual" | "api" | "cli" | "push" | "pull_request" | "rerun" | "patch" | "demo";
export type ArtifactKind = "log" | "waveform" | "coverage" | "model" | "source" | "report" | "patch";

/** Events delivered to browsers over SSE (and stored for replay). */
export const EVENT_TYPES = ["JOB_QUEUED", "JOB_STARTED", "TEST_STARTED", "TEST_COMPLETED", "TEST_FAILED", "COVERAGE_UPDATED", "JOB_COMPLETED"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface JobEvent {
  id: number; // monotonically increasing; used as SSE id for resume and de-duplication
  type: EventType;
  orgId: string;
  projectId: string;
  jobId: string;
  at: string;
  data: Record<string, unknown>;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface CoverageSummary {
  // Only metrics the simulator actually produced are present.
  line?: { covered: number; total: number };
  branch?: { covered: number; total: number };
  toggle?: { covered: number; total: number };
  functional?: { covered: number; total: number };
}

export const pct = (m?: { covered: number; total: number }) => (m && m.total > 0 ? (100 * m.covered) / m.total : undefined);

export interface AssertionFailureRecord {
  name: string;
  scope: string;
  severity: "error" | "fatal" | "warning";
  message: string;
  file: string;
  line: number;
  simTime: string | null;
}

export interface TestResultRecord {
  status: TaskState;
  exitCode: number | null;
  simTime: string | null;
  durationMs: number;
  assertions: AssertionFailureRecord[];
  checkFailures: string[];
  summary: string;
}
