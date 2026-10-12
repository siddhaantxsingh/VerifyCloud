/**
 * Where to go after login: only a path on this origin. "/\evil.com",
 * "/%09/evil.com" and similar strings pass a naive startsWith("/") check but
 * browsers treat them as another host (audit 2026-10-08, S10).
 */
export function safeNext(next: string | null, origin: string): string {
  if (!next) return "/";
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
