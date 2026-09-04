import { Transaction } from "../types/transaction"

/**
 * Canonical encoding rules (SPEC.md).
 *
 * The encoders below produce the bytes that ed25519 signatures are made over,
 * so they must be INJECTIVE: two distinct values may never produce the same
 * bytes, and a value the format cannot represent must be REJECTED rather than
 * silently coerced into something else. Every helper here therefore validates
 * its input and throws; nothing is truncated, rounded or stringified as
 * "undefined".
 *
 * The wire format for valid inputs is unchanged, so signatures made before
 * this validation was added still verify.
 */

/** Largest integer a JavaScript number can represent exactly: 2**53 - 1. */
export const MAX_CANONICAL_UINT = Number.MAX_SAFE_INTEGER

/** Largest byte length a 2-byte big-endian length prefix can carry. */
export const MAX_LENGTH_PREFIX = 0xffff

/**
 * A value that cannot be encoded canonically. Callers that encode untrusted
 * input (gossip handlers, the JSON-RPC surface) should treat this as "reject
 * the message", never as "encode something close enough".
 */
export class CanonicalEncodingError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalEncodingError"
    // keeps `instanceof` working if this is ever compiled down to ES5
    Object.setPrototypeOf(this, CanonicalEncodingError.prototype)
  }
}

/**
 * Assert that `n` is a value the uint64 encoder can represent exactly.
 *
 * Rejects non-numbers, NaN, Infinity, negative numbers, fractions and anything
 * above Number.MAX_SAFE_INTEGER. Without this, 1 and 1.5 encode to the same
 * eight bytes (one signature valid for two different transactions) and -1
 * encodes as 0xffffffffffffffff, colliding with the maximum uint64.
 */
export function assertUint64(n: unknown, field: string): number {
  if (typeof n !== "number") {
    throw new CanonicalEncodingError(
      `${field} must be a number, got ${describe(n)}`
    )
  }
  if (!Number.isFinite(n)) {
    throw new CanonicalEncodingError(`${field} must be finite, got ${String(n)}`)
  }
  if (!Number.isInteger(n)) {
    throw new CanonicalEncodingError(
      `${field} must be an integer, got ${String(n)}`
    )
  }
  if (n < 0) {
    throw new CanonicalEncodingError(
      `${field} must not be negative, got ${String(n)}`
    )
  }
  if (n > MAX_CANONICAL_UINT) {
    throw new CanonicalEncodingError(
      `${field} must be <= ${MAX_CANONICAL_UINT} (2**53 - 1), got ${String(n)}`
    )
  }
  return n
}

/** Assert that `s` is a string (a missing field must never encode as "undefined"). */
export function assertString(s: unknown, field: string): string {
  if (typeof s !== "string") {
    throw new CanonicalEncodingError(
      `${field} must be a string, got ${describe(s)}`
    )
  }
  return s
}

function describe(v: unknown): string {
  if (v === null) return "null"
  if (typeof v === "undefined") return "undefined"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "bigint") return `bigint ${String(v)}`
  return typeof v
}

/**
 * Two-byte big-endian length prefix. Throws above 0xffff instead of writing the
 * length modulo 65536, which would break the injectivity of the framing.
 */
function u16be(len: number, field: string): Uint8Array {
  if (!Number.isInteger(len) || len < 0) {
    throw new CanonicalEncodingError(
      `${field} length must be a non-negative integer, got ${String(len)}`
    )
  }
  if (len > MAX_LENGTH_PREFIX) {
    throw new CanonicalEncodingError(
      `${field} is ${len} bytes; the 2-byte length prefix carries at most ${MAX_LENGTH_PREFIX}`
    )
  }
  const buf = new Uint8Array(2)
  buf[0] = (len >> 8) & 0xff
  buf[1] = len & 0xff
  return buf
}

function u64be(n: number, field: string): Uint8Array {
  assertUint64(n, field)
  const buf = new Uint8Array(8)
  // encode as big-endian uint64
  const hi = Math.floor(n / 2 ** 32)
  const lo = n >>> 0
  buf[0] = (hi >>> 24) & 0xff
  buf[1] = (hi >>> 16) & 0xff
  buf[2] = (hi >>> 8) & 0xff
  buf[3] = hi & 0xff
  buf[4] = (lo >>> 24) & 0xff
  buf[5] = (lo >>> 16) & 0xff
  buf[6] = (lo >>> 8) & 0xff
  buf[7] = lo & 0xff
  return buf
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Encode `s` as a length-prefixed UTF-8 field, validating both type and length. */
function lengthPrefixedString(s: unknown, field: string): Uint8Array[] {
  const bytes = utf8Bytes(assertString(s, field))
  return [u16be(bytes.length, field), bytes]
}

/** Encode raw bytes as a length-prefixed field. */
function lengthPrefixedBytes(b: Uint8Array, field: string): Uint8Array[] {
  return [u16be(b.length, field), b]
}

/**
 * Deterministic JSON with sorted object keys.
 *
 * Values JSON cannot round-trip are rejected rather than emitted as "null" or
 * "undefined": undefined, NaN, Infinity, -Infinity, functions, symbols and
 * bigints all throw, because each of them would make two distinct payloads
 * share signing bytes.
 */
export function stableStringify(obj: unknown, field = "payload"): string {
  return stringifyAt(obj, field)
}

function stringifyAt(value: unknown, path: string): string {
  const t = typeof value
  if (t === "undefined") {
    throw new CanonicalEncodingError(`${path} is undefined and cannot be encoded`)
  }
  if (t === "function" || t === "symbol") {
    throw new CanonicalEncodingError(`${path} is a ${t} and cannot be encoded`)
  }
  if (t === "bigint") {
    throw new CanonicalEncodingError(
      `${path} is a bigint; encode it as a decimal string instead`
    )
  }
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalEncodingError(
        `${path} must be a finite number, got ${String(value)}`
      )
    }
    return JSON.stringify(value)
  }
  if (value === null || t !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return (
      "[" + value.map((v, i) => stringifyAt(v, `${path}[${i}]`)).join(",") + "]"
    )
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return (
    "{" +
    keys
      .map(
        (k) => JSON.stringify(k) + ":" + stringifyAt(record[k], `${path}.${k}`)
      )
      .join(",") +
    "}"
  )
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * The only fields a transaction may carry. The encoder covers exactly these, so
 * anything else on the object is invisible to the bytes: without this check a
 * relay could bolt an extra field onto a transaction and the leaf hash, the
 * Merkle root, the block hash and the proposer's header signature would all
 * stay valid. Rejecting unknown fields keeps the encoding injective over the
 * OBJECT, not merely over the five fields it happens to read.
 */
export const CANONICAL_TX_FIELDS = [
  "sender",
  "recipient",
  "amount",
  "nonce",
  "payload",
] as const

/**
 * Fields the encoder KNOWS about but deliberately leaves out of the bytes.
 *
 * `signature` is the ed25519 signature MADE OVER this encoding, so it cannot be
 * part of its own preimage. Excluding it here (rather than rejecting it as an
 * unknown field) keeps canonicalEncoding usable as the signing preimage both
 * before and after a transaction is signed, and leaves every signature and test
 * vector made under the previous rules valid: the bytes for the five signed
 * fields are byte-for-byte what they were.
 *
 * The signature is NOT left uncommitted, though — src/block.ts hashes the
 * Merkle leaf over "stx:" || len(signature) || signature || canonicalEncoding(tx),
 * so a relay that strips or swaps a signature changes the root.
 */
export const CANONICAL_TX_EXCLUDED_FIELDS = ["signature"] as const

const CANONICAL_TX_KNOWN_FIELD_SET: ReadonlySet<string> = new Set([
  ...CANONICAL_TX_FIELDS,
  ...CANONICAL_TX_EXCLUDED_FIELDS,
])

export function canonicalEncoding(tx: Transaction): Uint8Array {
  if (tx === null || typeof tx !== "object") {
    throw new CanonicalEncodingError(
      `transaction must be an object, got ${describe(tx)}`
    )
  }
  const unknown = Object.keys(tx as Record<string, unknown>)
    .filter((k) => !CANONICAL_TX_KNOWN_FIELD_SET.has(k))
    .sort()
  if (unknown.length > 0) {
    throw new CanonicalEncodingError(
      `transaction has unknown field(s) ${unknown.join(", ")}; only ` +
        `${CANONICAL_TX_FIELDS.join(", ")} can be encoded`
    )
  }
  const parts: Uint8Array[] = []
  parts.push(utf8Bytes("tx:"))

  parts.push(...lengthPrefixedString(tx.sender, "tx.sender"))
  parts.push(...lengthPrefixedString(tx.recipient, "tx.recipient"))

  parts.push(u64be(tx.amount, "tx.amount"))
  parts.push(u64be(tx.nonce, "tx.nonce"))

  if (typeof tx.payload === "undefined") {
    parts.push(u16be(0, "tx.payload"))
  } else {
    const pBytes = utf8Bytes(stableStringify(tx.payload, "tx.payload"))
    parts.push(...lengthPrefixedBytes(pBytes, "tx.payload"))
  }

  return concat(parts)
}

export type CanonicalBlockHeader = {
  parentHash: string
  height: number
  timestamp: number
  merkleRoot: string
  // proposerPublicKey is raw bytes (Uint8Array) when present; absent means zero-length
  proposerPublicKey?: Uint8Array
}

export function canonicalBlockEncoding(header: CanonicalBlockHeader): Uint8Array {
  if (header === null || typeof header !== "object") {
    throw new CanonicalEncodingError(
      `block header must be an object, got ${describe(header)}`
    )
  }
  const parts: Uint8Array[] = []
  parts.push(utf8Bytes("blk:"))

  parts.push(...lengthPrefixedString(header.parentHash, "header.parentHash"))

  parts.push(u64be(header.height, "header.height"))
  parts.push(u64be(header.timestamp, "header.timestamp"))

  parts.push(...lengthPrefixedString(header.merkleRoot, "header.merkleRoot"))

  if (
    typeof header.proposerPublicKey === "undefined" ||
    header.proposerPublicKey === null
  ) {
    parts.push(u16be(0, "header.proposerPublicKey"))
  } else {
    const pk = header.proposerPublicKey
    if (!(pk instanceof Uint8Array)) {
      throw new CanonicalEncodingError(
        `header.proposerPublicKey must be a Uint8Array, got ${describe(pk)}`
      )
    }
    parts.push(...lengthPrefixedBytes(pk, "header.proposerPublicKey"))
  }

  return concat(parts)
}
