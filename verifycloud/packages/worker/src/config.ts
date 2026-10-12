// Worker configuration (environment variables).
import { cpus, hostname, totalmem } from "node:os";

export interface WorkerConfig {
  apiUrl: string;                 // internal API base, e.g. http://api:8080
  registrationToken: string;
  name: string;
  sandbox: "docker" | "process";
  allowUnsafeProcessSandbox: boolean;
  simImage: string;
  cpus: number;                   // CPUs this worker offers to tasks
  memoryMb: number;
  workDir: string;
  limits: {
    maxLogBytes: number;          // kept per run; the rest is counted and reported as truncated
    hardOutputBytes: number;      // beyond this the run is killed (output flood)
    maxOutDirBytes: number;       // files a run may write (coverage, waveform)
    maxWaveformBytes: number;     // larger waveforms are not uploaded (reported)
    maxRepoBytes: number;
    pids: number;
    gitTimeoutMs: number;
  };
  pollIntervalMs: number;
}

const int = (n: string, d: number) => (process.env[n] ? Number(process.env[n]) : d);

export function loadWorkerConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  const e = process.env;
  return {
    apiUrl: (e.API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
    registrationToken: e.WORKER_REGISTRATION_TOKEN ?? "dev-worker-token",
    name: e.WORKER_NAME ?? hostname(),
    sandbox: (e.SANDBOX as WorkerConfig["sandbox"]) ?? "docker",
    allowUnsafeProcessSandbox: e.ALLOW_UNSAFE_PROCESS_SANDBOX === "true",
    simImage: e.SIM_IMAGE ?? "verifycloud-sim:verilator",
    cpus: int("WORKER_CPUS", cpus().length),
    memoryMb: int("WORKER_MEMORY_MB", Math.floor(totalmem() / 1024 / 1024 * 0.75)),
    workDir: e.WORK_DIR ?? "/tmp/verifycloud-worker",
    limits: {
      maxLogBytes: int("MAX_LOG_BYTES", 8 * 1024 * 1024),
      hardOutputBytes: int("HARD_OUTPUT_BYTES", 64 * 1024 * 1024),
      maxOutDirBytes: int("MAX_OUT_DIR_BYTES", 1024 * 1024 * 1024),
      maxWaveformBytes: int("MAX_WAVEFORM_BYTES", 256 * 1024 * 1024),
      maxRepoBytes: int("MAX_REPO_BYTES", 512 * 1024 * 1024),
      pids: int("SANDBOX_PIDS", 512),
      gitTimeoutMs: int("GIT_TIMEOUT_MS", 120_000),
    },
    pollIntervalMs: int("POLL_INTERVAL_MS", 1000),
    ...over,
  };
}
