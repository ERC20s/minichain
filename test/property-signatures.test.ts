import fc from "fast-check"
import { keypairFromSeed, sign, verify } from "../src/crypto/ed25519"
import { bytesToHex, signTransaction, verifyTransaction } from "../src/tx"
import { SignedTransaction } from "../src/types/transaction"

/**
 * Property: a transaction signature verifies <=> it was made by the key its
 * `sender` names, over exactly these fields (src/tx.ts, src/crypto/ed25519.ts).
 */
// tweetnacl's key derivation is slow under jest's VM (tens of ms per key), so
// the properties draw from a pool of keys made once, and run fewer cases: the
// cases are about the body and the key PAIRING, not about the seed entropy.
const RUNS = { numRuns: 30 }
const POOL = 4
const pool = Array.from({ length: POOL }, (_, i) => keypairFromSeed(new Uint8Array(32).fill(i + 1)))
const keyArb = fc.integer({ min: 0, max: POOL - 1 }).map((i) => pool[i])
const text = fc.string({ unit: "binary", maxLength: 24 })
const uint = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const bodyArb = fc.record({
  recipient: text,
  amount: uint,
  nonce: uint,
  payload: fc.option(fc.jsonValue({ maxDepth: 2 }), { nil: undefined }),
})

type Body = { recipient: string; amount: number; nonce: number; payload?: unknown }

function unsigned(b: Body): Omit<Body, "payload"> & { payload?: unknown } {
  return b.payload === undefined
    ? { recipient: b.recipient, amount: b.amount, nonce: b.nonce }
    : { recipient: b.recipient, amount: b.amount, nonce: b.nonce, payload: b.payload }
}

describe("signature verifies <=> signed by the sender's key", () => {
  it("signed by the key: verifies, and sender is that key", () => {
    fc.assert(
      fc.property(keyArb, bodyArb, (key, body) => {
        const tx = signTransaction(unsigned(body), key.secretKey)
        expect(tx.sender).toBe(bytesToHex(key.publicKey))
        expect(verifyTransaction(tx)).toBe(true)
      }),
      RUNS
    )
  })

  it("signed by another key: does not verify under this sender", () => {
    fc.assert(
      fc.property(keyArb, keyArb, bodyArb, (a, b, body) => {
        fc.pre(a !== b)
        const signedByB = signTransaction(unsigned(body), b.secretKey)
        // the same body, claimed for A, carrying B's signature
        const forged: SignedTransaction = { ...signedByB, sender: bytesToHex(a.publicKey) }
        expect(verifyTransaction(forged)).toBe(false)
      }),
      RUNS
    )
  })

  it("any change to a signed field breaks verification", () => {
    fc.assert(
      fc.property(keyArb, bodyArb, fc.integer({ min: 0, max: 3 }), (key, body, which) => {
        const tx = signTransaction(unsigned(body), key.secretKey)
        const changed: SignedTransaction = { ...tx }
        if (which === 0) changed.recipient = tx.recipient + "x"
        if (which === 1) changed.amount = tx.amount === Number.MAX_SAFE_INTEGER ? tx.amount - 1 : tx.amount + 1
        if (which === 2) changed.nonce = tx.nonce === Number.MAX_SAFE_INTEGER ? tx.nonce - 1 : tx.nonce + 1
        if (which === 3) changed.payload = { changed: true, was: tx.payload === undefined ? null : tx.payload }
        expect(verifyTransaction(changed)).toBe(false)
      }),
      RUNS
    )
  })

  it("random signature bytes never verify", () => {
    fc.assert(
      fc.property(keyArb, bodyArb, fc.uint8Array({ minLength: 64, maxLength: 64 }), (key, body, junk) => {
        const tx = signTransaction(unsigned(body), key.secretKey)
        expect(verifyTransaction({ ...tx, signature: bytesToHex(junk) })).toBe(false)
      }),
      RUNS
    )
  })

  it("the raw primitive agrees: verify(m, sign(m, k), pk(k)) and nothing else", () => {
    fc.assert(
      fc.property(keyArb, keyArb, fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), (a, b, m, m2) => {
        const sig = sign(m, a.secretKey)
        expect(verify(m, sig, a.publicKey)).toBe(true)
        if (a !== b) expect(verify(m, sig, b.publicKey)).toBe(false)
        if (!Buffer.from(m).equals(Buffer.from(m2))) expect(verify(m2, sig, a.publicKey)).toBe(false)
      }),
      RUNS
    )
  })
})
