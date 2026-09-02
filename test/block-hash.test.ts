import { blockHash, createBlock, Block } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { keypairFromSeed, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

describe("blockHash v1", () => {
  it("is deterministic for the same header", () => {
    const blk: Block = {
      parentHash: "0x00",
      height: 3,
      timestamp: 1700000000,
      transactions: [],
      merkleRoot: "abcd",
    }
    expect(blockHash(blk)).toEqual(blockHash({ ...blk }))
    expect(blockHash(blk)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("differs for blocks with identical transactions but different height or timestamp", () => {
    const base: Block = {
      parentHash: "0x00",
      height: 1,
      timestamp: 1700000000,
      transactions: [],
      merkleRoot: "abcd",
    }
    const otherHeight = { ...base, height: 2 }
    const otherTime = { ...base, timestamp: 1700000001 }

    // identical transaction lists -> identical merkle roots, distinct identities
    expect(base.merkleRoot).toEqual(otherHeight.merkleRoot)
    expect(base.merkleRoot).toEqual(otherTime.merkleRoot)
    expect(blockHash(base)).not.toEqual(blockHash(otherHeight))
    expect(blockHash(base)).not.toEqual(blockHash(otherTime))
  })

  it("is not the merkle root: two empty blocks at different heights collide on merkleRoot only", () => {
    const a = createBlock("0x00", 0, [])
    const b: Block = { ...a, height: 1 }
    expect(a.merkleRoot).toEqual(b.merkleRoot)
    expect(blockHash(a)).not.toEqual(blockHash(b))
  })

  it("can be computed from the block alone (proposer key is not committed)", () => {
    const blk = createBlock("0x00", 0, [])
    const roundTripped = JSON.parse(JSON.stringify(blk)) as Block
    expect(blockHash(roundTripped)).toEqual(blockHash(blk))
  })
})

describe("Node linkage by block hash", () => {
  it("rejects a signed block whose parentHash is the parent's merkleRoot", async () => {
    const portA = 9311
    const portB = 9312
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const genesis = createBlock("0x00", 0, [])

    const nodeA = new Node(portA, [urlB], genesis)
    const nodeB = new Node(portB, [urlA], genesis)

    const seed = new Uint8Array(32)
    seed[0] = 3
    const kp = keypairFromSeed(seed)

    // old-style linkage: parentHash = parent's merkle root
    const bad = createBlock(genesis.merkleRoot, 1, [{ sender: "alice", recipient: "bob", amount: 1, nonce: 1 }])
    const badMsg = canonicalBlockEncoding({
      parentHash: bad.parentHash,
      height: bad.height,
      timestamp: bad.timestamp,
      merkleRoot: bad.merkleRoot,
      proposerPublicKey: kp.publicKey,
    })
    const badSig = sign(badMsg, kp.secretKey)

    await wait(50)
    nodeA.broadcastBlock(bad, badSig, kp.publicKey)
    await wait(150)

    // the signature is valid, so only the linkage rule can reject it
    expect(nodeB.tip.height).toBe(0)
    expect(nodeB.tipHash).toEqual(blockHash(genesis))

    // the same block, correctly linked by block hash, is accepted
    const good = createBlock(blockHash(genesis), 1, [{ sender: "alice", recipient: "bob", amount: 1, nonce: 1 }])
    const goodMsg = canonicalBlockEncoding({
      parentHash: good.parentHash,
      height: good.height,
      timestamp: good.timestamp,
      merkleRoot: good.merkleRoot,
      proposerPublicKey: kp.publicKey,
    })
    const goodSig = sign(goodMsg, kp.secretKey)

    nodeA.broadcastBlock(good, goodSig, kp.publicKey)
    await wait(150)

    nodeA.close()
    nodeB.close()

    expect(nodeB.tip.height).toBe(1)
    expect(nodeB.tipHash).toEqual(blockHash(good))
  }, 4000)
})
