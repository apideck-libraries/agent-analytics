/**
 * Dependency-free CIDR matching for IPv4 and IPv6.
 *
 * Kept separate from {@link verifyBotIdentity} so the matching logic can be
 * tested in isolation — a wrong answer here silently turns a real crawler into
 * a "spoofed" one, which is worse than not verifying at all.
 *
 * Everything is parsed once into numeric form (`number` for v4, `bigint` for
 * v6) and compared with masks. No allocation per request beyond the parse of
 * the incoming IP.
 */

/** Parse dotted-quad IPv4 into a 32-bit unsigned integer. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    // Reject empty, non-numeric, out-of-range, and leading-zero forms
    // (`01.2.3.4` is ambiguous — some parsers read it as octal).
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part[0] === '0') return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8) | n
  }
  // `>>> 0` converts the signed 32-bit result back to unsigned.
  return out >>> 0
}

/**
 * Parse IPv6 (including `::` compression and IPv4-mapped tails like
 * `::ffff:1.2.3.4`) into a 128-bit BigInt.
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  let text = ip
  // Strip a zone index (`fe80::1%eth0`) — irrelevant for range membership.
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (!text || text.indexOf(':') === -1) return null

  // An embedded IPv4 tail contributes the low 32 bits.
  let tail: number | null = null
  const lastColon = text.lastIndexOf(':')
  const maybeV4 = text.slice(lastColon + 1)
  if (maybeV4.indexOf('.') !== -1) {
    tail = ipv4ToInt(maybeV4)
    if (tail === null) return null
    text = text.slice(0, lastColon + 1) + '0:0'
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null

  let groups: string[]
  if (rest === null) {
    groups = head
    if (groups.length !== 8) return null
  } else {
    const fill = 8 - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...rest]
  }

  let out = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    out = (out << 16n) | BigInt(parseInt(g, 16))
  }
  // Overwrite the low 32 bits with the embedded IPv4 value when present.
  if (tail !== null) out = ((out >> 32n) << 32n) | BigInt(tail >>> 0)
  return out
}

interface V4Range {
  net: number
  mask: number
}
interface V6Range {
  net: bigint
  bits: number
}

export interface CompiledRanges {
  /**
   * IPv4 ranges bucketed by first octet. A vendor can publish hundreds of
   * prefixes (OpenAI: 372) and a linear scan walked all of them on every
   * request; bucketing turns the common case into one map lookup plus a
   * handful of comparisons. Prefixes shorter than /8 span several buckets and
   * are held in `v4Wide`, which stays tiny.
   */
  v4: Map<number, V4Range[]>
  v4Wide: V4Range[]
  v6: V6Range[]
}

/**
 * Pre-compile a list of CIDR strings into numeric form. Invalid entries are
 * dropped rather than thrown — a malformed line in a vendor's published feed
 * shouldn't take down the whole check.
 */
export function compileRanges(cidrs: readonly string[]): CompiledRanges {
  const v4 = new Map<number, V4Range[]>()
  const v4Wide: V4Range[] = []
  const v6: V6Range[] = []
  for (const cidr of cidrs) {
    const slash = cidr.lastIndexOf('/')
    if (slash === -1) continue
    const addr = cidr.slice(0, slash)
    const bits = Number(cidr.slice(slash + 1))
    if (!Number.isInteger(bits) || bits < 0) continue

    if (addr.indexOf(':') !== -1) {
      if (bits > 128) continue
      const net = ipv6ToBigInt(addr)
      if (net === null) continue
      v6.push({ net: bits === 0 ? 0n : (net >> BigInt(128 - bits)) << BigInt(128 - bits), bits })
    } else {
      if (bits > 32) continue
      const net = ipv4ToInt(addr)
      if (net === null) continue
      // `bits === 0` needs special handling: `<<32` is a no-op in JS, not zero.
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      const entry = { net: (net & mask) >>> 0, mask }
      if (bits >= 8) {
        const bucket = entry.net >>> 24
        const list = v4.get(bucket)
        if (list) list.push(entry)
        else v4.set(bucket, [entry])
      } else {
        v4Wide.push(entry)
      }
    }
  }
  return { v4, v4Wide, v6 }
}

/** True when `ip` falls inside any range in the pre-compiled set. */
export function ipInRanges(ip: string, ranges: CompiledRanges): boolean {
  if (!ip) return false
  const trimmed = ip.trim()
  if (!trimmed) return false

  if (trimmed.indexOf(':') !== -1) {
    const value = ipv6ToBigInt(trimmed)
    if (value === null) return false
    // An IPv4-mapped address (::ffff:a.b.c.d) must also be checked against the
    // v4 list — Vercel and Cloudflare both emit this form on dual-stack edges.
    const V4_MAPPED_PREFIX = 0xffffn << 32n
    if ((value >> 32n) === V4_MAPPED_PREFIX >> 32n) {
      const low = Number(value & 0xffffffffn) >>> 0
      if (matchV4(low, ranges)) return true
    }
    for (const r of ranges.v6) {
      if (r.bits === 0) return true
      if ((value >> BigInt(128 - r.bits)) << BigInt(128 - r.bits) === r.net) return true
    }
    return false
  }

  const value = ipv4ToInt(trimmed)
  if (value === null) return false
  return matchV4(value, ranges)
}

function matchV4(value: number, ranges: CompiledRanges): boolean {
  const bucket = ranges.v4.get(value >>> 24)
  if (bucket) {
    for (const r of bucket) {
      if (((value & r.mask) >>> 0) === r.net) return true
    }
  }
  for (const r of ranges.v4Wide) {
    if (((value & r.mask) >>> 0) === r.net) return true
  }
  return false
}

/** Convenience wrapper — compiles on every call, so prefer {@link ipInRanges}. */
export function ipInCidr(ip: string, cidr: string): boolean {
  return ipInRanges(ip, compileRanges([cidr]))
}
