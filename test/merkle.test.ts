import { createHash } from "crypto"
import { merkleRoot, merkleLeafHash, merkleNodeHash, MERKLE_LEAF_TAG, MERKLE_NODE_TAG } from "../src/merkle"

function sha256(...parts: Buffer[]): Buffer {
  return createHash("sha256").update(Buffer.concat(parts)).digest()
}

/** sha256(0x00 || tx) — the leaf rule, recomputed independently of src/merkle.ts */
function leaf(s: string): Buffer {
  return sha256(Buffer.from([MERKLE_LEAF_TAG]), Buffer.from(s))
}

/** sha256(0x01 || left || right) — the internal-node rule */
function node(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.from([MERKLE_NODE_TAG]), left, right)
}

describe("merkle root", () => {
  it("empty list returns hash of empty byte string", () => {
    const r = merkleRoot([])
    expect(r).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"))
  })

  it("single transaction is the tagged leaf hash sha256(0x00 || tx)", () => {
    const tx = "{\"a\":1}"
    expect(merkleRoot([tx])).toBe(leaf(tx).toString("hex"))
    // and NOT the untagged sha256(tx) the old implementation returned
    expect(merkleRoot([tx])).not.toBe(createHash("sha256").update(Buffer.from(tx)).digest("hex"))
  })

  it("even number of txs hashes internal nodes with the 0x01 tag", () => {
    const a = "a"
    const b = "b"
    expect(merkleRoot([a, b])).toBe(node(leaf(a), leaf(b)).toString("hex"))
  })

  it("odd width PROMOTES the last node instead of duplicating it", () => {
    const [a, b, c] = ["a", "b", "c"]
    // layer 1: node(leaf a, leaf b), leaf c promoted unchanged
    const expected = node(node(leaf(a), leaf(b)), leaf(c)).toString("hex")
    expect(merkleRoot([a, b, c])).toBe(expected)
    // the old duplication rule would have hashed c against itself
    const duplicated = node(node(leaf(a), leaf(b)), node(leaf(c), leaf(c))).toString("hex")
    expect(merkleRoot([a, b, c])).not.toBe(duplicated)
  })

  it("a padded list cannot forge the root of the honest list", () => {
    const a = "a"
    const b = "b"
    const c = "c"
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([a, b, c, c]))
    // the same holds one layer up and for a five-element list
    expect(merkleRoot([a])).not.toBe(merkleRoot([a, a]))
    expect(merkleRoot([a, b, c, "d", "e"])).not.toBe(merkleRoot([a, b, c, "d", "e", "e"]))
  })

  it("five transactions promote across two layers", () => {
    const t = ["a", "b", "c", "d", "e"]
    const l = t.map(leaf)
    const layer1 = [node(l[0], l[1]), node(l[2], l[3]), l[4]] // e promoted
    const layer2 = [node(layer1[0], layer1[1]), layer1[2]] // e promoted again
    expect(merkleRoot(t)).toBe(node(layer2[0], layer2[1]).toString("hex"))
  })

  it("a 64-byte transaction cannot be passed off as an internal node", () => {
    const a = "a"
    const b = "b"
    // The bytes an attacker would need a leaf to hash to: left || right.
    const fake = Buffer.concat([leaf(a), leaf(b)])
    expect(fake.length).toBe(64)
    // Tagged differently, so the single-leaf tree over those 64 bytes is not
    // the two-leaf tree over [a, b].
    expect(merkleRoot([new Uint8Array(fake)])).not.toBe(merkleRoot([a, b]))
    const asLeaf = Buffer.from(merkleLeafHash(new Uint8Array(fake))).toString("hex")
    const asNode = Buffer.from(merkleNodeHash(leaf(a), leaf(b))).toString("hex")
    expect(asLeaf).not.toBe(asNode)
  })

  it("is order sensitive and stable across string / byte input", () => {
    expect(merkleRoot(["a", "b"])).not.toBe(merkleRoot(["b", "a"]))
    const bytes = ["a", "b"].map((s) => new TextEncoder().encode(s))
    expect(merkleRoot(bytes)).toBe(merkleRoot(["a", "b"]))
  })
})
