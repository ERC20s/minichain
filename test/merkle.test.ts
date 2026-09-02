import { merkleRoot } from "../src/merkle"

const crypto = require("crypto")

// Mirror of the spec: leaves are sha256(0x00 || bytes), internal nodes are
// sha256(0x01 || left || right). Computed here independently of src/merkle.ts.
function leaf(s: string): Buffer {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), Buffer.from(s)])).digest()
}

function node(left: Buffer, right: Buffer): Buffer {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), left, right])).digest()
}

describe("merkle root", () => {
  it("empty list returns the tagged hash of the empty transaction", () => {
    const r = merkleRoot([])
    const exp = crypto
      .createHash("sha256")
      .update(Buffer.from([0x00]))
      .digest("hex")
    expect(r).toBe(exp)
  })

  it("single transaction is the tagged leaf hash", () => {
    const tx = "{\"a\":1}"
    expect(merkleRoot([tx])).toBe(leaf(tx).toString("hex"))
  })

  it("even number of txs computes tagged internal nodes", () => {
    const a = "a"
    const b = "b"
    expect(merkleRoot([a, b])).toBe(node(leaf(a), leaf(b)).toString("hex"))
  })

  it("odd layer promotes the lone node unchanged", () => {
    const a = "a"
    const b = "b"
    const c = "c"
    const root = node(node(leaf(a), leaf(b)), leaf(c))
    expect(merkleRoot([a, b, c])).toBe(root.toString("hex"))
  })

  it("promotion is not duplication: [a,b,c] and [a,b,c,c] differ", () => {
    const a = "a"
    const b = "b"
    const c = "c"
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([a, b, c, c]))
  })

  it("a five leaf tree promotes across two layers", () => {
    const t = ["a", "b", "c", "d", "e"]
    const l = t.map(leaf)
    // layer1: N(l0,l1), N(l2,l3), l4   layer2: N(N(l0,l1),N(l2,l3)), l4
    const layer1a = node(l[0], l[1])
    const layer1b = node(l[2], l[3])
    const root = node(node(layer1a, layer1b), l[4])
    expect(merkleRoot(t)).toBe(root.toString("hex"))
  })

  it("a leaf preimage cannot be passed off as an internal node", () => {
    const a = "a"
    const b = "b"
    const inner = Buffer.concat([leaf(a), leaf(b)]) // 64 bytes, shaped like a node preimage
    expect(merkleRoot([inner])).not.toBe(merkleRoot([a, b]))
  })
})
