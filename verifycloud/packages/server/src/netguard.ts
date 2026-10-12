// SSRF protection for outbound requests to user-supplied URLs (notification
// webhooks). The target must be https (http only when explicitly allowed) and
// must resolve to public addresses only; the check runs inside the
// connection's DNS lookup, so a DNS-rebinding answer cannot bypass it.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent } from "undici";

// Separate lists: Node's BlockList matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so a "::ffff:0:0/96" rule in a shared list blocked EVERY IPv4
// address (audit 2026-10-08: webhooks to public IPv4 hosts never worked).
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["64:ff9b:1::", 48],
] as const)
  blocked6.addSubnet(net, prefix, "ipv6");

/** 16 bytes of an IPv6 literal (handles "::" and a trailing dotted IPv4). */
function v6bytes(addr: string): number[] | null {
  let a = addr;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const p = dotted[1]!.split(".").map(Number);
    a = a.slice(0, -dotted[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") : [a, null];
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g || "0", 16);
    return [(n >> 8) & 255, n & 255];
  });
}

/**
 * IPv4 address embedded in an IPv6 address by a translation mechanism, if
 * any: NAT64 well-known prefix 64:ff9b::/96, 6to4 2002::/16, deprecated
 * IPv4-compatible ::/96. Such addresses reach the embedded IPv4 host, so it
 * must be checked as well (audit 2026-10-08, S6).
 */
function embeddedV4(addr: string): string | null {
  const b = v6bytes(addr);
  if (!b) return null;
  const v4 = (o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return v4(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return v4(12); // IPv4-mapped
  if (b.slice(0, 12).every((x) => x === 0)) return v4(12);
  return null;
}

export function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 0) return false;
  if (fam === 4) return !blocked4.check(addr, "ipv4");
  if (blocked6.check(addr, "ipv6")) return false;
  const v4 = embeddedV4(addr);
  return !(v4 && blocked4.check(v4, "ipv4"));
}

export class UnsafeTargetError extends Error {}

export function validateTargetUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeTargetError("not a valid URL");
  }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) throw new UnsafeTargetError("only https URLs are allowed");
  if (u.username || u.password) throw new UnsafeTargetError("credentials in URLs are not allowed");
  // URL keeps IPv6 literals bracketed ("[::1]"); strip them before classifying
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && isIP(host) && !isPublicAddress(host)) throw new UnsafeTargetError("private or reserved addresses are not allowed");
  return u;
}

/** An undici dispatcher whose DNS lookup refuses non-public addresses. */
export function guardedAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      timeout: 10_000,
      lookup: (hostname, options, cb) => {
        dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
          if (err) return cb(err, "", 0);
          const list = addrs as unknown as LookupAddress[];
          const ok = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
          if (ok.length === 0) return cb(new UnsafeTargetError(`refusing to connect to ${hostname}: resolves to a private or reserved address`), "", 0);
          if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, ok);
          cb(null, ok[0]!.address, ok[0]!.family);
        });
      },
    },
  });
}
