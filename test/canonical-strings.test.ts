import {
  CanonicalEncodingError,
  canonicalEncoding,
  canonicalBlockEncoding,
  isWellFormedString,
  stableStringify,
} from "../src/coding/serialize"
import { keypairFromSeed } from "../src/crypto/ed25519"
import { signTransaction, verifyTransaction } from "../src/tx"
import { transactionLeaf } from "../src/block"

/**
 * Well-formed strings only (src/coding/serialize.ts, assertString).
 *
 * The WHATWG TextEncoder maps every lone surrogate to U+FFFD, so two distinct
 * JavaScript strings — both of which JSON carries intact over the wire — used
 * to encode to the same bytes. A transfer signed for recipient "�bob"
 * therefore verified, and built the same Merkle leaf, for recipient "\uD800bob":
 * a relay could redirect it in flight to a different ledger key.
 */
function kp(seedByte: number) {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

describe("canonical encoding refuses ill-formed strings", () => {
  const key = kp(51)
  const honest = "�bob" // a replacement character: well-formed
  const twin = "\uD800bob" // a lone high surrogate: ill-formed

  it("the two spellings are distinct strings that JSON keeps distinct", () => {
    expect(honest).not.toBe(twin)
    expect(JSON.parse(JSON.stringify(twin))).toBe(twin)
    expect(JSON.parse(JSON.stringify(honest))).toBe(honest)
  })

  it("but the UTF-8 encoder collapses them to the same bytes", () => {
    const enc = new TextEncoder()
    expect(enc.encode(twin)).toEqual(enc.encode(honest))
  })

  it("isWellFormedString tells them apart", () => {
    expect(isWellFormedString(honest)).toBe(true)
    expect(isWellFormedString(twin)).toBe(false)
    expect(isWellFormedString("\uDC00")).toBe(false) // lone low surrogate
    expect(isWellFormedString("😀")).toBe(true) // a real pair (😀)
    expect(isWellFormedString("")).toBe(true)
  })

  it("the encoder throws on a lone surrogate in sender, recipient or payload", () => {
    const base = { sender: "a", recipient: "b", amount: 1, nonce: 1 }
    expect(() => canonicalEncoding({ ...base, recipient: twin })).toThrow(CanonicalEncodingError)
    expect(() => canonicalEncoding({ ...base, sender: twin })).toThrow(CanonicalEncodingError)
    expect(() => canonicalEncoding({ ...base, payload: twin })).toThrow(CanonicalEncodingError)
    expect(() => canonicalEncoding({ ...base, payload: { note: twin } })).toThrow(CanonicalEncodingError)
    expect(() => canonicalEncoding({ ...base, payload: { [twin]: 1 } })).toThrow(CanonicalEncodingError)
    expect(() => stableStringify(["ok", "\uDC00"])).toThrow(CanonicalEncodingError)
    // and the honest spelling still encodes
    expect(canonicalEncoding({ ...base, recipient: honest }).length).toBeGreaterThan(0)
  })

  it("the same rule applies to a block header's strings", () => {
    const header = { parentHash: "ab", height: 1, timestamp: 1, merkleRoot: "cd" }
    expect(() => canonicalBlockEncoding({ ...header, parentHash: twin })).toThrow(CanonicalEncodingError)
    expect(() => canonicalBlockEncoding({ ...header, merkleRoot: twin })).toThrow(CanonicalEncodingError)
    expect(canonicalBlockEncoding(header).length).toBeGreaterThan(0)
  })

  it("a transfer signed for the honest recipient no longer verifies for the twin", () => {
    const tx = signTransaction({ recipient: honest, amount: 7, nonce: 1 }, key.secretKey)
    expect(verifyTransaction(tx)).toBe(true)
    const redirected = { ...tx, recipient: twin }
    expect(verifyTransaction(redirected)).toBe(false)
    // and it cannot be put in a block at all: the leaf refuses it
    expect(() => transactionLeaf(redirected)).toThrow(CanonicalEncodingError)
    expect(transactionLeaf(tx).length).toBeGreaterThan(0)
  })

  it("cannot even be signed for an ill-formed recipient", () => {
    expect(() => signTransaction({ recipient: twin, amount: 7, nonce: 1 }, key.secretKey)).toThrow(
      CanonicalEncodingError
    )
  })
})
