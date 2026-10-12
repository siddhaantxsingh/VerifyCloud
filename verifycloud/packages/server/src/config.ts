// Server configuration from environment variables. Every value has a
// development default; production requirements are enforced in
// assertProductionConfig (docs/deployment.md).
import { randomBytes } from "node:crypto";

export interface ServerConfig {
  port: number;
  host: string;
  publicUrl: string;               // external base URL (links in GitHub checks, emails)
  allowedOrigins: string[];        // browser origins allowed to make cookie-authenticated writes
  databaseUrl: string;
  s3: { endpoint?: string; region: string; bucket: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  secretKey: Buffer;               // 32 bytes, AES-256-GCM for stored secrets
  workerRegistrationToken: string; // shared secret a worker presents once to register
  cookieSecure: boolean;
  sessionTtlHours: number;
  logLevel: "debug" | "info" | "warn" | "error";
  production: boolean;
  publicDemo: boolean;             // public demo mode: no user code execution
  allowRegistration: boolean;
  requireEmailVerification: boolean;
  smtpUrl?: string;                // smtp://user:pass@host:port ; unset = emails logged (dev)
  mailFrom: string;
  github: {
    appId?: string;
    privateKey?: string;
    webhookSecret?: string;
    apiUrl: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthUrl: string;
  };
  ai: {
    openaiBaseUrl?: string;        // OpenAI-compatible chat completions endpoint base
    openaiApiKey?: string;
    openaiModel: string;
    localBaseUrl?: string;         // OpenAI-compatible server inside the deployment (e.g. Ollama)
    localModel: string;
    timeoutMs: number;
    maxContextBytes: number;
  };
  limits: {
    maxUploadBytes: number;        // source snapshot upload
    maxArtifactBytes: number;      // one artifact
    uploadMemoryBudgetBytes: number; // artifact bytes buffered in memory across concurrent uploads
    leaseSeconds: number;
    reaperIntervalMs: number;
    apiRatePerMinute: number;
    authRatePerMinute: number;
    jobCreatePerMinute: number;    // per organization
  };
  serveStatic?: string;            // built web app directory
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid integer in ${name}`);
  return n;
}
const bool = (name: string, def: boolean) => (process.env[name] === undefined ? def : process.env[name] === "true");

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const production = env.NODE_ENV === "production";
  const key = env.SECRET_ENCRYPTION_KEY ? Buffer.from(env.SECRET_ENCRYPTION_KEY, "base64") : randomBytes(32);
  if (key.length !== 32) throw new Error("SECRET_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  const port = int("PORT", 8080);
  const cfg: ServerConfig = {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/verifycloud",
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? "us-east-1",
      bucket: env.S3_BUCKET ?? "verifycloud",
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
    },
    secretKey: key,
    workerRegistrationToken: env.WORKER_REGISTRATION_TOKEN ?? "dev-worker-token",
    cookieSecure: bool("COOKIE_SECURE", production),
    sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7),
    logLevel: (env.LOG_LEVEL as ServerConfig["logLevel"]) ?? "info",
    production,
    publicDemo: bool("PUBLIC_DEMO", false),
    allowRegistration: bool("ALLOW_REGISTRATION", true),
    requireEmailVerification: bool("REQUIRE_EMAIL_VERIFICATION", false),
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM ?? "VerifyCloud <no-reply@localhost>",
    github: {
      appId: env.GITHUB_APP_ID || undefined,
      privateKey: env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") || undefined,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
      apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
      oauthClientId: env.GITHUB_OAUTH_CLIENT_ID || undefined,
      oauthClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET || undefined,
      oauthUrl: (env.GITHUB_OAUTH_URL ?? "https://github.com").replace(/\/$/, ""),
    },
    ai: {
      openaiBaseUrl: env.AI_OPENAI_BASE_URL || undefined,
      openaiApiKey: env.AI_OPENAI_API_KEY || undefined,
      openaiModel: env.AI_OPENAI_MODEL ?? "gpt-4o-mini",
      localBaseUrl: env.AI_LOCAL_BASE_URL || undefined,
      localModel: env.AI_LOCAL_MODEL ?? "llama3.1",
      timeoutMs: int("AI_TIMEOUT_MS", 60_000),
      maxContextBytes: int("AI_MAX_CONTEXT_BYTES", 48_000),
    },
    limits: {
      maxUploadBytes: int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
      maxArtifactBytes: int("MAX_ARTIFACT_BYTES", 512 * 1024 * 1024),
      uploadMemoryBudgetBytes: int("UPLOAD_MEMORY_BUDGET_BYTES", 1024 * 1024 * 1024),
      leaseSeconds: int("LEASE_SECONDS", 30),
      reaperIntervalMs: int("REAPER_INTERVAL_MS", 5_000),
      apiRatePerMinute: int("API_RATE_PER_MINUTE", 600),
      authRatePerMinute: int("AUTH_RATE_PER_MINUTE", 20),
      jobCreatePerMinute: int("JOB_CREATE_PER_MINUTE", 120),
    },
    serveStatic: env.STATIC_DIR || undefined,
    ...overrides,
  };
  if (production) assertProductionConfig(cfg);
  return cfg;
}

export function assertProductionConfig(cfg: ServerConfig) {
  const problems: string[] = [];
  if (!process.env.SECRET_ENCRYPTION_KEY) problems.push("SECRET_ENCRYPTION_KEY must be set (secrets would be unreadable after restart)");
  if (cfg.workerRegistrationToken === "dev-worker-token" || cfg.workerRegistrationToken.length < 24) problems.push("WORKER_REGISTRATION_TOKEN must be a long random value");
  if (!cfg.cookieSecure) problems.push("COOKIE_SECURE must be true in production");
  if (!cfg.publicUrl.startsWith("https://")) problems.push("PUBLIC_URL must be https in production");
  // behind a reverse proxy on the same host every request comes from
  // loopback, so the loopback exception would expose /metrics (audit S4)
  if (!process.env.METRICS_TOKEN || process.env.METRICS_TOKEN.length < 16) problems.push("METRICS_TOKEN must be set (16+ characters) in production");
  if (problems.length) throw new Error("unsafe production configuration:\n- " + problems.join("\n- "));
}
