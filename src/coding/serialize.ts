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

/**
 * A UTF-16 code unit that is not part of a surrogate pair: a high surrogate
 * with no low surrogate after it, or a low surrogate with no high one before.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Is `s` well-formed Unicode: no lone surrogate code units? */
export function isWellFormedString(s: string): boolean {
  return !LONE_SURROGATE.test(s)
}

/**
 * Assert that `s` is a WELL-FORMED string: a missing field must never encode as
 * "undefined", and a lone surrogate must never encode at all.
 *
 * The second rule is an injectivity rule. The encoder writes UTF-8, and the
 * WHATWG TextEncoder replaces every lone surrogate with U+FFFD, so the two
 * JavaScript strings "\uD800bob" and "\uFFFDbob" — distinct values, both of
 * which JSON carries faithfully across the wire — produced the SAME bytes. A
 * signature over one verified for the other, the Merkle leaf was the same, and
 * so a relay could rewrite the recipient of a signed transfer in flight to a
 * different account key and every rule still passed. Rejecting ill-formed
 * strings gives each encodable string exactly one encoding and each encoding
 * exactly one string.
 */
export function assertString(s: unknown, field: string): string {
  if (typeof s !== "string") {
    throw new CanonicalEncodingError(
      `${field} must be a string, got ${describe(s)}`
    )
  }
  if (!isWellFormedString(s)) {
    throw new CanonicalEncodingError(
      `${field} contains a lone surrogate; only well-formed Unicode can be encoded`
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
  if (t === "string") {
    // JSON.stringify escapes a lone surrogate as \udXXX, which is injective
    // as text, but a payload that cannot survive a UTF-8 round trip has no
    // place in a signed preimage: one rule for every string in a transaction.
    return JSON.stringify(assertString(value, path))
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
        (k) =>
          JSON.stringify(assertString(k, `${path} key`)) +
          ":" +
          stringifyAt(record[k], `${path}.${k}`)
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
  const unknown = Object.keys(tx)
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

/*
 * Decoders.
 *
 * The encodings above are SIGNING preimages: nothing on the wire carries them
 * (blocks and transactions travel as JSON) and nothing has to parse them to run
 * a node. The decoders exist to make injectivity TESTABLE as a round trip —
 * decode(encode(x)) must give back x, and encode(decode(bytes)) must give back
 * bytes — and they are as strict as the encoders: a prefix that is not the
 * domain tag, a field that runs past the end, a number above 2**53 - 1, a
 * string that is not valid UTF-8, a payload whose JSON is not already in the
 * sorted canonical form, or a single trailing byte all throw a
 * CanonicalEncodingError. A second encoding of one value is a decoder failure,
 * never a tolerated spelling.
 */

/** Reads length-prefixed fields and fixed-width integers off a byte string. */
class CanonicalReader {
  private off = 0
  constructor(private readonly bytes: Uint8Array, private readonly what: string) {
    if (!(bytes instanceof Uint8Array)) {
      throw new CanonicalEncodingError(`${what} must be a Uint8Array, got ${describe(bytes)}`)
    }
  }

  private need(n: number, field: string): void {
    if (this.off + n > this.bytes.length) {
      throw new CanonicalEncodingError(
        `${this.what} ends inside ${field}: needs ${n} more byte(s) at offset ${this.off}`
      )
    }
  }

  prefix(tag: string): void {
    const expected = utf8Bytes(tag)
    this.need(expected.length, "the domain tag")
    for (let i = 0; i < expected.length; i++) {
      if (this.bytes[this.off + i] !== expected[i]) {
        throw new CanonicalEncodingError(`${this.what} does not start with ${JSON.stringify(tag)}`)
      }
    }
    this.off += expected.length
  }

  u16(field: string): number {
    this.need(2, field)
    const n = (this.bytes[this.off] << 8) | this.bytes[this.off + 1]
    this.off += 2
    return n
  }

  u64(field: string): number {
    this.need(8, field)
    let hi = 0
    let lo = 0
    for (let i = 0; i < 4; i++) hi = hi * 256 + this.bytes[this.off + i]
    for (let i = 4; i < 8; i++) lo = lo * 256 + this.bytes[this.off + i]
    this.off += 8
    const n = hi * 2 ** 32 + lo
    // 2**53 - 1 is the largest value u64be can have written, so anything above
    // it is not an encoding this format produces.
    if (n > MAX_CANONICAL_UINT) {
      throw new CanonicalEncodingError(`${field} is above ${MAX_CANONICAL_UINT} (2**53 - 1)`)
    }
    return n
  }

  bytes16(field: string): Uint8Array {
    const len = this.u16(field)
    this.need(len, field)
    const out = this.bytes.slice(this.off, this.off + len)
    this.off += len
    return out
  }

  string16(field: string): string {
    const raw = this.bytes16(field)
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
    } catch (e) {
      throw new CanonicalEncodingError(`${field} is not valid UTF-8`)
    }
    // Decoded text is always well-formed, but the encoder refuses a lone
    // surrogate, so this is the same rule read back: the bytes an encoder
    // could not have written are not an encoding.
    return assertString(text, field)
  }

  end(): void {
    if (this.off !== this.bytes.length) {
      throw new CanonicalEncodingError(
        `${this.what} has ${this.bytes.length - this.off} trailing byte(s) after the last field`
      )
    }
  }
}

/** A transaction read back from canonicalEncoding(): the five signed fields, no signature. */
export type DecodedTransaction = Pick<Transaction, "sender" | "recipient" | "amount" | "nonce" | "payload">

/**
 * Inverse of canonicalEncoding() over its range. `payload` is absent when the
 * encoded payload length is zero (the encoder writes a zero length for an
 * undefined payload and never for a defined one, because JSON text is never
 * empty). A payload whose JSON text is not the sorted canonical form
 * stableStringify would produce is refused.
 */
export function decodeCanonicalEncoding(bytes: Uint8Array): DecodedTransaction {
  const r = new CanonicalReader(bytes, "transaction encoding")
  r.prefix("tx:")
  const sender = r.string16("tx.sender")
  const recipient = r.string16("tx.recipient")
  const amount = r.u64("tx.amount")
  const nonce = r.u64("tx.nonce")
  const payloadText = r.string16("tx.payload")
  r.end()
  if (payloadText.length === 0) return { sender, recipient, amount, nonce }
  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch (e) {
    throw new CanonicalEncodingError("tx.payload is not JSON")
  }
  if (stableStringify(payload, "tx.payload") !== payloadText) {
    throw new CanonicalEncodingError("tx.payload is JSON but not in canonical (sorted-key) form")
  }
  return { sender, recipient, amount, nonce, payload }
}

/**
 * Inverse of canonicalBlockEncoding() over its range. `proposerPublicKey` is
 * absent when the encoded key length is zero, which is how a Block's own hash
 * preimage is written (src/block.ts).
 */
export function decodeCanonicalBlockEncoding(bytes: Uint8Array): CanonicalBlockHeader {
  const r = new CanonicalReader(bytes, "block header encoding")
  r.prefix("blk:")
  const parentHash = r.string16("header.parentHash")
  const height = r.u64("header.height")
  const timestamp = r.u64("header.timestamp")
  const merkleRoot = r.string16("header.merkleRoot")
  const proposerPublicKey = r.bytes16("header.proposerPublicKey")
  r.end()
  const header: CanonicalBlockHeader = { parentHash, height, timestamp, merkleRoot }
  if (proposerPublicKey.length > 0) header.proposerPublicKey = proposerPublicKey
  return header
}
