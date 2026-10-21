import fc from "fast-check"
import {
  CanonicalEncodingError,
  canonicalBlockEncoding,
  canonicalEncoding,
  decodeCanonicalBlockEncoding,
  decodeCanonicalEncoding,
  stableStringify,
} from "../src/coding/serialize"
import { Block, blockHash, createBlock } from "../src/block"
import { account } from "./helpers/signed-tx"
import { signTransaction, UnsignedTransaction } from "../src/tx"
import { Keypair } from "../src/crypto/ed25519"
import { SignedTransaction } from "../src/types/transaction"

// Key derivation is slow under jest, so each seed's keypair is made once.
const keys = new Map<number, Keypair>()
function keyFor(seed: number): Keypair {
  let k = keys.get(seed)
  if (!k) {
    k = account(seed)
    keys.set(seed, k)
  }
  return k
}
function signedTx(seed: number, tx: Omit<UnsignedTransaction, "sender">): SignedTransaction {
  return signTransaction(tx, keyFor(seed).secretKey)
}
const seedArb = fc.integer({ min: 1, max: 6 })

/**
 * Property-based round trips for the canonical encodings
 * (src/coding/serialize.ts) and for the JSON wire form of a block.
 *
 * The canonical encodings are signing preimages and must be INJECTIVE. The
 * strict decoders added beside them make that a checkable property:
 *   decode(encode(x)) == x        (no information is lost)
 *   encode(decode(b)) == b        (no second spelling of one value decodes)
 * plus: two distinct values never share an encoding.
 */
const RUNS = { numRuns: 300 }

/** Well-formed strings of any code point, short enough for a u16 length. */
const text = fc.string({ unit: "binary", maxLength: 40 })
const uint = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
/** A JSON payload, or none. */
const payload = fc.option(fc.jsonValue({ maxDepth: 3 }), { nil: undefined })

const txArb = fc.record(
  { sender: text, recipient: text, amount: uint, nonce: uint, payload },
  { requiredKeys: ["sender", "recipient", "amount", "nonce"] }
)

/** JSON normalisation, so -0 and 0 (which JSON cannot tell apart) compare equal. */
function viaJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

describe("canonical transaction encoding round-trips", () => {
  it("decode(encode(tx)) gives back the five signed fields", () => {
    fc.assert(
      fc.property(txArb, (tx) => {
        const decoded = decodeCanonicalEncoding(canonicalEncoding(tx))
        expect(decoded.sender).toBe(tx.sender)
        expect(decoded.recipient).toBe(tx.recipient)
        expect(decoded.amount).toBe(tx.amount)
        expect(decoded.nonce).toBe(tx.nonce)
        if (tx.payload === undefined) {
          expect("payload" in decoded).toBe(false)
        } else {
          expect(viaJson(decoded.payload)).toEqual(viaJson(tx.payload))
          expect(stableStringify(decoded.payload)).toBe(stableStringify(tx.payload))
        }
      }),
      RUNS
    )
  })

  it("encode(decode(bytes)) reproduces the bytes exactly", () => {
    fc.assert(
      fc.property(txArb, (tx) => {
        const bytes = canonicalEncoding(tx)
        expect(canonicalEncoding(decodeCanonicalEncoding(bytes))).toEqual(bytes)
      }),
      RUNS
    )
  })

  it("two transactions that differ in a signed field never share an encoding", () => {
    fc.assert(
      fc.property(txArb, txArb, (a, b) => {
        const same =
          a.sender === b.sender &&
          a.recipient === b.recipient &&
          a.amount === b.amount &&
          a.nonce === b.nonce &&
          (a.payload === undefined) === (b.payload === undefined) &&
          (a.payload === undefined || stableStringify(a.payload) === stableStringify(b.payload))
        const equalBytes = Buffer.from(canonicalEncoding(a)).equals(Buffer.from(canonicalEncoding(b)))
        expect(equalBytes).toBe(same)
      }),
      RUNS
    )
  })

  it("a signed transaction's encoding ignores the signature and survives the JSON wire", () => {
    fc.assert(
      fc.property(seedArb, text, uint, uint, payload, (seed, recipient, amount, nonce, p) => {
        const tx = signedTx(seed, p === undefined ? { recipient, amount, nonce } : { recipient, amount, nonce, payload: p })
        const wire = JSON.parse(JSON.stringify(tx)) as SignedTransaction
        expect(canonicalEncoding(wire)).toEqual(canonicalEncoding(tx))
        const { signature, ...unsigned } = tx
        expect(canonicalEncoding(unsigned)).toEqual(canonicalEncoding(tx))
      }),
      { numRuns: 40 }
    )
  })

  it("the decoder refuses a truncated or padded encoding", () => {
    fc.assert(
      fc.property(txArb, fc.integer({ min: 1, max: 8 }), (tx, n) => {
        const bytes = canonicalEncoding(tx)
        expect(() => decodeCanonicalEncoding(bytes.slice(0, bytes.length - n))).toThrow(CanonicalEncodingError)
        const padded = new Uint8Array(bytes.length + n)
        padded.set(bytes, 0)
        expect(() => decodeCanonicalEncoding(padded)).toThrow(CanonicalEncodingError)
      }),
      { numRuns: 100 }
    )
  })

  it("the decoder refuses a payload that is JSON but not in canonical key order", () => {
    // Hand-build an encoding whose payload text is {"b":1,"a":2}: valid JSON,
    // but not what stableStringify writes, so it is a second spelling.
    const canonical = canonicalEncoding({ sender: "s", recipient: "r", amount: 1, nonce: 2, payload: { a: 2, b: 1 } })
    const canonicalText = '{"a":2,"b":1}'
    const swappedText = '{"b":1,"a":2}'
    const enc = new TextEncoder()
    const tail = enc.encode(canonicalText)
    const head = canonical.slice(0, canonical.length - tail.length)
    const swapped = new Uint8Array(head.length + tail.length)
    swapped.set(head, 0)
    swapped.set(enc.encode(swappedText), head.length)
    expect(decodeCanonicalEncoding(canonical).payload).toEqual({ a: 2, b: 1 })
    expect(() => decodeCanonicalEncoding(swapped)).toThrow(CanonicalEncodingError)
  })

  it("the decoder refuses a wrong domain tag and bad UTF-8", () => {
    const bytes = canonicalEncoding({ sender: "s", recipient: "r", amount: 1, nonce: 2 })
    const wrongTag = Uint8Array.from(bytes)
    wrongTag[0] = "b".charCodeAt(0)
    expect(() => decodeCanonicalEncoding(wrongTag)).toThrow(CanonicalEncodingError)
    // sender "s" is at offset 3 (tag) + 2 (length): overwrite with a lone 0xff
    const badUtf8 = Uint8Array.from(bytes)
    badUtf8[5] = 0xff
    expect(() => decodeCanonicalEncoding(badUtf8)).toThrow(CanonicalEncodingError)
  })
})

describe("canonical block header encoding round-trips", () => {
  const headerArb = fc.record({
    parentHash: text,
    height: uint,
    timestamp: uint,
    merkleRoot: text,
    proposerPublicKey: fc.option(fc.uint8Array({ minLength: 1, maxLength: 64 }), { nil: undefined }),
  })

  it("decode(encode(header)) == header and encode(decode(bytes)) == bytes", () => {
    fc.assert(
      fc.property(headerArb, (h) => {
        const bytes = canonicalBlockEncoding(h)
        const decoded = decodeCanonicalBlockEncoding(bytes)
        expect(decoded.parentHash).toBe(h.parentHash)
        expect(decoded.height).toBe(h.height)
        expect(decoded.timestamp).toBe(h.timestamp)
        expect(decoded.merkleRoot).toBe(h.merkleRoot)
        if (h.proposerPublicKey === undefined) expect(decoded.proposerPublicKey).toBeUndefined()
        else expect(decoded.proposerPublicKey).toEqual(h.proposerPublicKey)
        expect(canonicalBlockEncoding(decoded)).toEqual(bytes)
      }),
      RUNS
    )
  })

  it("a u64 above 2**53 - 1 is not an encoding and is refused", () => {
    const bytes = canonicalBlockEncoding({ parentHash: "p", height: 1, timestamp: 1, merkleRoot: "m" })
    // height sits right after "blk:" (4) + u16 (2) + "p" (1) = offset 7
    const bad = Uint8Array.from(bytes)
    bad[7] = 0x00
    bad[8] = 0x20 // 2**53 exactly
    for (let i = 9; i < 15; i++) bad[i] = 0
    expect(() => decodeCanonicalBlockEncoding(bad)).toThrow(CanonicalEncodingError)
    bad[8] = 0x1f
    for (let i = 9; i < 15; i++) bad[i] = 0xff // 2**53 - 1
    expect(decodeCanonicalBlockEncoding(bad).height).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe("a block survives the JSON wire with one hash and one root", () => {
  const txListArb = fc.array(
    fc.record({ seed: seedArb, recipient: text, amount: uint, nonce: uint }),
    { maxLength: 4 }
  )

  it("JSON.parse(JSON.stringify(block)) has the same block hash, root and header bytes", () => {
    fc.assert(
      fc.property(txListArb, fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (list, stamp) => {
        const txs = list.map((t) => signedTx(t.seed, { recipient: t.recipient, amount: t.amount, nonce: t.nonce }))
        const blk = createBlock("parent", 1, txs, stamp)
        const wire = JSON.parse(JSON.stringify(blk)) as Block
        expect(blockHash(wire)).toBe(blockHash(blk))
        expect(createBlock(wire.parentHash, wire.height, wire.transactions, wire.timestamp).merkleRoot).toBe(blk.merkleRoot)
        const header = (b: Block) =>
          canonicalBlockEncoding({
            parentHash: b.parentHash,
            height: b.height,
            timestamp: b.timestamp,
            merkleRoot: b.merkleRoot,
            proposerPublicKey: keyFor(1).publicKey,
          })
        expect(header(wire)).toEqual(header(blk))
      }),
      { numRuns: 40 }
    )
  })
})
