import nacl from "tweetnacl"
import {
  ED25519_GROUP_ORDER_LE,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  isCanonicalSignature,
  keypairFromSeed,
  sign,
  verify,
} from "../src/crypto/ed25519"
import { signTransaction, verifyTransaction, bytesToHex } from "../src/tx"
import { transactionId } from "../src/state/mempool"

/**
 * ed25519 signature malleability (src/crypto/ed25519.ts).
 *
 * A signature is (R, S) with S a scalar mod L. tweetnacl verifies the group
 * equation with S read as a plain 256-bit integer and never checks S < L, so
 * (R, S + L) verifies whenever (R, S) does. This chain commits to the
 * signature BYTES (Merkle leaf, mempool id), so one signed transfer had two
 * valid spellings. verify() now refuses any S >= L and any wrong-sized input.
 */
const L = (BigInt(1) << BigInt(252)) + BigInt("27742317777372353535851937790883648493")

function leToBigInt(bytes: Uint8Array): bigint {
  let n = BigInt(0)
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << BigInt(8)) | BigInt(bytes[i])
  return n
}

function bigIntToLe(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & BigInt(0xff))
    n >>= BigInt(8)
  }
  return out
}

/** The same signature with S replaced by S + L: a second encoding of one signature. */
function malleate(sig: Uint8Array): Uint8Array {
  const S = leToBigInt(sig.slice(32))
  const out = new Uint8Array(64)
  out.set(sig.slice(0, 32), 0)
  out.set(bigIntToLe(S + L, 32), 32)
  return out
}

function kp(seedByte: number) {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

describe("ed25519 canonical signature encoding", () => {
  const key = kp(41)
  const message = new TextEncoder().encode("the quick brown fox")
  const sig = sign(message, key.secretKey)

  it("pins the group order constant to L = 2^252 + 27742317777372353535851937790883648493", () => {
    expect(leToBigInt(Uint8Array.from(ED25519_GROUP_ORDER_LE))).toBe(L)
    expect(ED25519_GROUP_ORDER_LE.length).toBe(32)
  })

  it("a signature this module makes is canonical and verifies", () => {
    expect(sig.length).toBe(ED25519_SIGNATURE_BYTES)
    expect(leToBigInt(sig.slice(32)) < L).toBe(true)
    expect(isCanonicalSignature(sig)).toBe(true)
    expect(verify(message, sig, key.publicKey)).toBe(true)
  })

  it("the underlying library accepts S + L — the malleability being closed", () => {
    const mal = malleate(sig)
    expect(mal).not.toEqual(sig)
    // S + L still fits in 32 bytes, so this is a distinct 64-byte string...
    expect(leToBigInt(mal.slice(32))).toBe(leToBigInt(sig.slice(32)) + L)
    // ...that tweetnacl, on its own, verifies.
    expect(nacl.sign.detached.verify(message, mal, key.publicKey)).toBe(true)
  })

  it("verify() refuses S + L although the library would accept it", () => {
    const mal = malleate(sig)
    expect(isCanonicalSignature(mal)).toBe(false)
    expect(verify(message, mal, key.publicKey)).toBe(false)
  })

  it("refuses S exactly equal to L and accepts S = L - 1 as an encoding", () => {
    // Neither of these is a valid signature of anything; they pin the boundary
    // of the canonical check itself, independent of the group equation.
    const atL = new Uint8Array(64)
    atL.set(bigIntToLe(L, 32), 32)
    expect(isCanonicalSignature(atL)).toBe(false)
    const belowL = new Uint8Array(64)
    belowL.set(bigIntToLe(L - BigInt(1), 32), 32)
    expect(isCanonicalSignature(belowL)).toBe(true)
    const maxS = new Uint8Array(64).fill(0xff)
    expect(isCanonicalSignature(maxS)).toBe(false)
  })

  it("answers false, never throws, for wrong-sized keys and signatures", () => {
    expect(verify(message, sig.slice(0, 63), key.publicKey)).toBe(false)
    expect(verify(message, new Uint8Array(65), key.publicKey)).toBe(false)
    expect(verify(message, sig, key.publicKey.slice(0, 31))).toBe(false)
    expect(verify(message, sig, new Uint8Array(ED25519_PUBLIC_KEY_BYTES + 1))).toBe(false)
    expect(verify(message, sig, kp(42).publicKey)).toBe(false)
    expect(verify((null as unknown) as Uint8Array, sig, key.publicKey)).toBe(false)
  })

  it("a malleated transaction signature is refused, so one transfer has one id", () => {
    const tx = signTransaction({ recipient: "bob", amount: 5, nonce: 1 }, key.secretKey)
    expect(verifyTransaction(tx)).toBe(true)
    const sigBytes = Buffer.from(tx.signature, "hex")
    const twin = { ...tx, signature: bytesToHex(malleate(sigBytes)) }
    expect(twin.signature).not.toBe(tx.signature)
    // the library alone would have let the twin through...
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode("x"),
        new Uint8Array(64),
        key.publicKey
      )
    ).toBe(false) // (sanity: the library does reject a real forgery)
    // ...and the twin would have had a DIFFERENT mempool id and Merkle leaf
    expect(transactionId(twin)).not.toBe(transactionId(tx))
    // so it must not verify
    expect(verifyTransaction(twin)).toBe(false)
  })
})
