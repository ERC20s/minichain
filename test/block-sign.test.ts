import { canonicalBlockEncoding, CanonicalBlockHeader } from "../src/coding/serialize"
import { keypairFromSeed, sign, verify } from "../src/crypto/ed25519"

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}

describe("block header signing", () => {
  it("signs and verifies a block header", () => {
    const seed = new Uint8Array(32)
    seed[0] = 1
    const kp = keypairFromSeed(seed)

    const header: CanonicalBlockHeader = {
      parentHash: "0000",
      height: 5,
      timestamp: 1234567890,
      merkleRoot: "abcd",
      proposerPublicKey: kp.publicKey,
    }

    const msg = canonicalBlockEncoding(header)
    const sig = sign(msg, kp.secretKey)
    expect(verify(msg, sig, kp.publicKey)).toBe(true)

    // tamper: change height
    const h2 = { ...header, height: 6 }
    const msg2 = canonicalBlockEncoding(h2)
    expect(verify(msg2, sig, kp.publicKey)).toBe(false)
  })

  it("produces deterministic signature for fixed seed and header", () => {
    const seed = new Uint8Array(32)
    for (let i = 0; i < 32; i++) seed[i] = i
    const kp = keypairFromSeed(seed)

    const header: CanonicalBlockHeader = {
      parentHash: "p",
      height: 42,
      timestamp: 7,
      merkleRoot: "m",
      proposerPublicKey: kp.publicKey,
    }
    const msg = canonicalBlockEncoding(header)
    const sig1 = sign(msg, kp.secretKey)
    const sig2 = sign(msg, kp.secretKey)
    expect(hex(sig1)).toEqual(hex(sig2))
    expect(sig1.length).toBe(64)
  })
})
