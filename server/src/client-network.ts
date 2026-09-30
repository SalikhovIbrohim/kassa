import { isIP } from "node:net";

/**
 * The key a client is counted under when guessing passwords. A person on an IPv6 network
 * can pick any address inside their own /64, so counting single addresses would let them
 * start over at will: IPv6 is counted by its /64. IPv4 addresses, and IPv6 addresses that
 * wrap one ("::ffff:203.0.113.7"), are counted as they are.
 */
export function clientNetwork(ip: string): string {
  const wrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (wrapped) return wrapped[1]!;
  if (isIP(ip) !== 6) return ip;

  const groups = expandIPv6(ip);
  if (!groups) return ip;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** Eight 16-bit groups of an IPv6 address, or null for forms this does not handle. */
function expandIPv6(ip: string): number[] | null {
  const address = ip.split("%")[0]!;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 0) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? gap : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}
