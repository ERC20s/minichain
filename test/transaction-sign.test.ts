import { canonicalEncoding } from "../src/coding/serialize"
import { keypairFromSeed, sign, verify } from "../src/crypto/ed25519"

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}

describe("transaction signing", () => {
  it("signs and verifies a transaction", () => {
    const seed = new Uint8Array(32)
    seed[0] = 1
    const kp = keypairFromSeed(seed)

    const tx = {
      sender: "alice",
      recipient: "bob",
      amount: 100,
      nonce: 1,
      payload: { note: "hello" },
    }

    const msg = canonicalEncoding(tx as any)
    const sig = sign(msg, kp.secretKey)
    expect(verify(msg, sig, kp.publicKey)).toBe(true)

    // tamper
    const tx2 = { ...tx, amount: 101 }
    const msg2 = canonicalEncoding(tx2 as any)
    expect(verify(msg2, sig, kp.publicKey)).toBe(false)
  })

  it("produces deterministic signature for fixed seed and tx", () => {
    const seed = new Uint8Array(32)
    for (let i = 0; i < 32; i++) seed[i] = i
    const kp = keypairFromSeed(seed)

    const tx = { sender: "s", recipient: "r", amount: 42, nonce: 7 }
    const msg = canonicalEncoding(tx as any)
    const sig1 = sign(msg, kp.secretKey)
    const sig2 = sign(msg, kp.secretKey)
    expect(hex(sig1)).toEqual(hex(sig2))

    // known-length check: signature is 64 bytes
    expect(sig1.length).toBe(64)
  })
})
