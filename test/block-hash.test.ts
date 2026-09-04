import { createHash } from "crypto"
import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding, CanonicalEncodingError } from "../src/coding/serialize"
import { keypairFromSeed, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { signedTx } from "./helpers/signed-tx"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

/** A look-alike of `b`: same transactions (so same merkleRoot), different header. */
function withTimestamp(b: Block, timestamp: number): Block {
  return { ...b, timestamp }
}

describe("blockHash identifies a block by its whole header", () => {
  it("two blocks with the same transactions share a merkleRoot but not a blockHash", () => {
    const txs = [signedTx(21, { recipient: "bob", amount: 1, nonce: 1 })]
    const a = createBlock("0x00", 1, txs)
    const b = withTimestamp(a, a.timestamp + 1000)

    // this is exactly why the merkle root cannot be a link: it is blind to the
    // timestamp, the height and the parent
    expect(b.merkleRoot).toBe(a.merkleRoot)
    expect(blockHash(a)).not.toBe(blockHash(b))

    // height is covered too
    expect(blockHash({ ...a, height: a.height + 1 })).not.toBe(blockHash(a))
    // and so is the parent link, so the whole chain is tamper-evident
    expect(blockHash({ ...a, parentHash: "0x01" })).not.toBe(blockHash(a))
  })

  it("every empty block used to be interchangeable; now each one is distinct", () => {
    const g1 = createBlock("0x00", 0, [])
    const g2 = createBlock("0xff", 0, [])
    expect(g2.merkleRoot).toBe(g1.merkleRoot) // sha256 of no input, for both
    expect(blockHash(g2)).not.toBe(blockHash(g1))
  })

  it("is a 64-character hex digest and is deterministic", () => {
    const b = createBlock("0x00", 3, [signedTx(22, { recipient: "b", amount: 2, nonce: 7 })])
    const h = blockHash(b)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(blockHash(b)).toBe(h)
  })

  it("survives a JSON.stringify/parse round trip", () => {
    const b = createBlock("0x00", 1, [signedTx(23, { recipient: "bob", amount: 1, nonce: 1 })])
    const wire = JSON.parse(JSON.stringify(b)) as Block
    expect(blockHash(wire)).toBe(blockHash(b))
  })

  it("is domain separated from the block signing preimage", () => {
    const b = createBlock("0x00", 1, [])
    const signingBytes = canonicalBlockEncoding({
      parentHash: b.parentHash,
      height: b.height,
      timestamp: b.timestamp,
      merkleRoot: b.merkleRoot,
    })
    // the hash is taken over "blkhash:" || signingBytes, never over signingBytes
    const bare = createHash("sha256").update(Buffer.from(signingBytes)).digest("hex")
    expect(blockHash(b)).not.toBe(bare)
  })

  it("rejects a header the canonical encoder cannot represent", () => {
    const b = createBlock("0x00", 1, [])
    expect(() => blockHash({ ...b, timestamp: 1.5 })).toThrow(CanonicalEncodingError)
    expect(() => blockHash({ ...b, parentHash: undefined as any })).toThrow(CanonicalEncodingError)
  })
})

describe("a node links children by block hash, not by merkle root", () => {
  it("rejects a child of a look-alike tip that shares the tip's merkleRoot", async () => {
    const portA = 9311
    const portB = 9312
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const genesisA = createBlock("0x00", 0, [])
    // same (empty) transaction list, so the same merkleRoot — a different block
    const genesisB = withTimestamp(genesisA, genesisA.timestamp + 5000)
    expect(genesisB.merkleRoot).toBe(genesisA.merkleRoot)

    const nodeA = new Node(portA, [urlB], genesisA)
    const nodeB = new Node(portB, [urlA], genesisB)

    const seed = new Uint8Array(32)
    seed[0] = 3
    const kp = keypairFromSeed(seed)

    // a well-formed, correctly signed child of genesisA
    const child = createBlock(blockHash(genesisA), 1, [
      signedTx(24, { recipient: "bob", amount: 1, nonce: 1 }),
    ])
    const msg = canonicalBlockEncoding({
      parentHash: child.parentHash,
      height: child.height,
      timestamp: child.timestamp,
      merkleRoot: child.merkleRoot,
      proposerPublicKey: kp.publicKey,
    })
    const sig = sign(msg, kp.secretKey)

    await wait(50)
    nodeA.broadcastBlock(child, sig, kp.publicKey)
    await wait(200)

    nodeA.close()
    nodeB.close()

    // node B's tip is the look-alike, so this child does not build on it.
    // Under the old merkleRoot linkage it would have been accepted.
    expect(nodeB.tip.height).toBe(0)
    expect(nodeB.tip.timestamp).toBe(genesisB.timestamp)
  }, 4000)
})
