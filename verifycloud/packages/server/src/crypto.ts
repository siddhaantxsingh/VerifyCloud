// Password hashing, token generation, secret encryption.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const scryptAsync = (pw: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pw, salt, len, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Hash of a random password, used to equalize timing for unknown accounts.
let dummy: Promise<string> | undefined;
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  const s = stored ?? (await dummy);
  const [alg, n, r, p, saltB64, keyB64] = s.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (e, k) => (e ? reject(e) : resolve(k))),
  );
  return timingSafeEqual(key, expected) && stored !== null;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();
export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A bearer token with a recognizable prefix (so secret scanners and our redactor can find it). */
export function newToken(kind: "pat" | "key" | "wrk" | "sess"): { token: string; hash: Buffer; prefix: string } {
  const body = randomBytes(32).toString("base64url");
  const token = `vc_${kind}_${body}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 12) };
}

export function encryptSecret(key: Buffer, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), nonce };
}

export function decryptSecret(key: Buffer, ciphertext: Buffer, nonce: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
