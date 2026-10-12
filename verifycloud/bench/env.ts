// Records the environment a benchmark ran in (written next to every result).
import { execSync } from "node:child_process";
import { cpus, totalmem, release } from "node:os";

const sh = (c: string) => {
  try {
    return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

export function environment() {
  return {
    date: new Date().toISOString(),
    cpuModel: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    memoryGiB: +(totalmem() / 1024 ** 3).toFixed(1),
    kernel: release(),
    node: process.version,
    postgres: sh("psql --version"),
    docker: sh("docker version --format '{{.Server.Version}}'"),
    verilator: sh("docker run --rm --network none verifycloud-sim:verilator verilator --version"),
    objectStorage: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000 (moto S3 emulator)",
    note: "API, PostgreSQL, object storage, workers and load generator all ran on this single host",
  };
}

export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return +sorted[i]!.toFixed(2);
}

export function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.length ? +s[s.length - 1]!.toFixed(2) : null, mean: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : null };
}
