import { isIP } from "node:net";

/**
 * Is this address one a business's webhook may legitimately be at? Anything that could be OUR network (loopback, private, link-local, cloud
 * metadata at 169.254.169.254, carrier-grade NAT, documentation and benchmark ranges, multicast, reserved) is refused, for IPv4 and IPv6,
 * including IPv4 hidden inside IPv6 (::ffff:10.0.0.1, 64:ff9b::/96, 6to4). The webhook URL is typed in by staff, but a business could point
 * its DNS name at 10.x tomorrow: the address is checked AFTER resolving, and the connection is made to that same address (no second lookup).
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address.split(".").map(Number) as [number, number, number, number]);
  if (version === 6) return isPublicV6(address);
  return false;
}

function isPublicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(address: string): boolean {
  const groups = expandV6(address);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const embeddedV4 = (hi: number, lo: number): boolean => isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (groups.every((group) => group === 0)) return false; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embeddedV4(g6, g7); // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false; // ::a.b.c.d (deprecated IPv4-compatible)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedV4(g6, g7); // NAT64
  if (g0 === 0x2002) return embeddedV4(g1, g2); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only
  return true;
}

/** Eight 16-bit groups, or undefined if it is not a valid IPv6 address. Handles "::" compression and a trailing dotted IPv4. */
function expandV6(address: string): number[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => part > 255)) return undefined;
    text = text.slice(0, text.length - dotted[1]!.length) + ((parts[0]! << 8) | parts[1]!).toString(16) + ":" + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.length !== 8) return undefined;
  const numbers = all.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
}
