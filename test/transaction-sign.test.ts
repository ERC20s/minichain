import { keypairFromSeed, signTransaction, verifySignedTransaction } from "../src/crypto/ed25519"

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}

describe("transaction signing", () => {
  it("signs and verifies a transaction using SignedTransaction helpers", () => {
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

    const stx = signTransaction(tx as any, kp.secretKey)
    expect(verifySignedTransaction(stx)).toBe(true)

    // tamper
    const tx2 = { ...tx, amount: 101 }
    const stx2 = { ...stx, ...tx2 }
    expect(verifySignedTransaction(stx2 as any)).toBe(false)
  })

  it("produces deterministic signature for fixed seed and tx and has known length", () => {
    const seed = new Uint8Array(32)
    for (let i = 0; i < 32; i++) seed[i] = i
    const kp = keypairFromSeed(seed)

    const tx = { sender: "s", recipient: "r", amount: 42, nonce: 7 }
    const stx1 = signTransaction(tx as any, kp.secretKey)
    const stx2 = signTransaction(tx as any, kp.secretKey)
    expect(hex(stx1.signature)).toEqual(hex(stx2.signature))

    // known-length check: signature is 64 bytes
    expect(stx1.signature.length).toBe(64)
  })
})
