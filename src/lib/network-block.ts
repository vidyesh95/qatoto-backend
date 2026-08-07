/**
 * Parsing a client address down to the network block the fraud guard reasons about.
 *
 * A MODULE OF ITS OWN, for the reason `utc-day.ts` is one: `client-subnet.ts` reads `config`
 * at module scope to reach the hashing secret, so anything importing the parser from there
 * transitively required a fully populated environment. That is harmless in a running process
 * and fatal in a unit test, which is exactly where a parser like this needs to be exercised
 * — two hosts in one office must land in one block, and two unrelated networks must not.
 *
 * Nothing here reads a secret, a clock or a database. `client-subnet.ts` re-exports it, so
 * existing imports are unaffected.
 */
import { isIP } from "node:net";

/** IPv4: keep the first three octets. */
const IPV4_BLOCK_OCTETS = 3;
/** IPv6: keep the first 56 bits — seven bytes, i.e. three and a half hextets. */
const IPV6_BLOCK_BYTES = 7;

/**
 * `::ffff:203.0.113.5` — an IPv4 address arriving over an IPv6 socket. Node reports these
 * as IPv6, and hashing the textual form would put the same host in two different
 * "networks" depending on which listener accepted it.
 */
const IPV4_MAPPED_PREFIX = /^::ffff:/i;

function normalizeIpv4Block(address: string): string | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;

  for (const octet of octets) {
    // `Number("")` is 0 and `Number(" 1")` is 1, so parse strictly rather than coercing.
    if (!/^\d{1,3}$/.test(octet)) return null;
    if (Number(octet) > 255) return null;
  }

  return `v4:${octets.slice(0, IPV4_BLOCK_OCTETS).join(".")}`;
}

function normalizeIpv6Block(address: string): string | null {
  // Expand `::` and any omitted leading zeroes into sixteen bytes.
  const [head, tail] = address.split("::");
  const headGroups = head === undefined || head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");

  if (address.includes("::")) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    headGroups.push(...Array.from({ length: missing }, () => "0"), ...tailGroups);
  }
  if (headGroups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of headGroups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return `v6:${bytes
    .slice(0, IPV6_BLOCK_BYTES)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The network block an address belongs to, as a stable string — exported for tests, which
 * need to assert that two addresses in one block agree and two in different blocks do not
 * WITHOUT knowing the deployment secret.
 *
 * `null` means "no honest answer": no address, or one that does not parse. A caller must
 * store `null` rather than substituting a placeholder, because a shared placeholder would
 * make every address-less request look like one enormous colluding network.
 */
export function deriveClientNetworkBlock(clientIp: string | undefined): string | null {
  if (clientIp === undefined) return null;

  const trimmed = clientIp.trim();
  if (trimmed === "") return null;

  const unmapped = IPV4_MAPPED_PREFIX.test(trimmed)
    ? trimmed.replace(IPV4_MAPPED_PREFIX, "")
    : trimmed;

  const family = isIP(unmapped);
  if (family === 4) return normalizeIpv4Block(unmapped);
  if (family === 6) return normalizeIpv6Block(unmapped);
  return null;
}
