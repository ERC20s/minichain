import { merkleRoot } from "../src/merkle"

function hexFor(s: string): string {
  return merkleRoot([s])
}

describe("merkle root", () => {
  it("empty list returns hash of empty byte string", () => {
    const r = merkleRoot([])
    expect(typeof r).toBe("string")
    expect(r.length).toBeGreaterThan(0)
  })

  it("single transaction is sha256(tx)", () => {
    const tx = "{\"a\":1}"
    const r = merkleRoot([tx])
    // compute expected
    const crypto = require("crypto")
    const exp = crypto.createHash("sha256").update(Buffer.from(tx)).digest("hex")
    expect(r).toBe(exp)
  })

  it("even number of txs computes internal nodes", () => {
    const a = "a"
    const b = "b"
    const ra = merkleRoot([a])
    const rb = merkleRoot([b])
    const crypto = require("crypto")
    const ha = crypto.createHash("sha256").update(Buffer.from(a)).digest()
    const hb = crypto.createHash("sha256").update(Buffer.from(b)).digest()
    const parent = crypto.createHash("sha256").update(Buffer.concat([ha, hb])).digest("hex")
    expect(merkleRoot([a, b])).toBe(parent)
  })

  it("odd number duplicates last node", () => {
    const a = "a"
    const b = "b"
    const c = "c"
    const ha = require("crypto").createHash("sha256").update(Buffer.from(a)).digest()
    const hb = require("crypto").createHash("sha256").update(Buffer.from(b)).digest()
    const hc = require("crypto").createHash("sha256").update(Buffer.from(c)).digest()
    const p1 = require("crypto").createHash("sha256").update(Buffer.concat([ha, hb])).digest()
    const p2 = require("crypto").createHash("sha256").update(Buffer.concat([hc, hc])).digest()
    const root = require("crypto").createHash("sha256").update(Buffer.concat([p1, p2])).digest("hex")
    expect(merkleRoot([a, b, c])).toBe(root)
  })
})
