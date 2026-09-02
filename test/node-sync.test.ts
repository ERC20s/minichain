import { Node } from "../src/node"
import { keypairFromSeed, sign } from "../src/crypto/ed25519"
import { blockHash, createBlock } from "../src/block"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

describe("in-memory Node syncing over gossip", () => {
  it("propagates and validates a signed block between two nodes", async () => {
    const portA = 9301
    const portB = 9302
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const genesis = createBlock("0x00", 0, [])

    const nodeA = new Node(portA, [urlB], genesis)
    const nodeB = new Node(portB, [urlA], genesis)

    const seed = new Uint8Array(32)
    seed[0] = 2
    const kp = keypairFromSeed(seed)

    // create a new block building on genesis
    const blk = createBlock(blockHash(genesis), 1, [{ sender: "alice", recipient: "bob", amount: 1, nonce: 1 }])

    // sign canonical header
    const header = {
      parentHash: blk.parentHash,
      height: blk.height,
      timestamp: blk.timestamp,
      merkleRoot: blk.merkleRoot,
      proposerPublicKey: kp.publicKey,
    }

    // import canonical encoding helper directly to mirror Node logic
    const { canonicalBlockEncoding } = await import("../src/coding/serialize")
    const msg = canonicalBlockEncoding(header as any)
    const sig = sign(msg, kp.secretKey)

    // give servers a moment to start
    await wait(50)

    nodeA.broadcastBlock(blk, sig, kp.publicKey)

    await wait(200)

    // close nodes
    nodeA.close()
    nodeB.close()

    expect(nodeA.tip.height).toBe(1)
    expect(nodeB.tip.height).toBe(1)
    expect(nodeA.tip.merkleRoot).toEqual(nodeB.tip.merkleRoot)
    // both nodes agree on block identity, and it is the accepted block's hash
    expect(nodeA.tipHash).toEqual(nodeB.tipHash)
    expect(nodeA.tipHash).toEqual(blockHash(blk))
  }, 2000)
})
