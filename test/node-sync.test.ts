import { Node } from "../src/node"
import { keypairFromSeed, sign } from "../src/crypto/ed25519"
import { blockHash, createBlock } from "../src/block"
import { funded, signedTx } from "./helpers/signed-tx"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

describe("in-memory Node syncing over gossip", () => {
  it("propagates and validates a signed block between two nodes", async () => {
    const portA = 9301
    const portB = 9302
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const genesis = createBlock("0x00", 0, [])

    // both nodes open with account 11 funded: the transfer below is affordable
    const opening = funded([11])
    const nodeA = new Node(portA, [urlB], genesis, [], opening)
    const nodeB = new Node(portB, [urlA], genesis, [], opening)

    const seed = new Uint8Array(32)
    seed[0] = 2
    const kp = keypairFromSeed(seed)

    // create a new block building on genesis, linked by the genesis BLOCK HASH
    // the transaction is signed by its sender: a block whose transactions are
    // not authorised is dropped by the peer before the tip moves
    const blk = createBlock(blockHash(genesis), 1, [
      signedTx(11, { recipient: "bob", amount: 1, nonce: 1 }),
    ])

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

    try {
      // Broadcast only once both links are open. A dials B before B listens, so
      // A's link comes up on a re-dial, after the backoff, not at once.
      for (let i = 0; i < 60; i++) {
        if (nodeA.peerCounts().outbound > 0 && nodeB.peerCounts().outbound > 0) break
        await wait(50)
      }
      expect(nodeA.peerCounts().outbound).toBe(1)
      expect(nodeB.peerCounts().outbound).toBe(1)

      nodeA.broadcastBlock(blk, sig, kp.publicKey)

      // B accepts the block and relays it, which is how A's own tip moves.
      for (let i = 0; i < 60 && (nodeA.tip.height < 1 || nodeB.tip.height < 1); i++) await wait(50)

      expect(nodeA.tip.height).toBe(1)
      expect(nodeB.tip.height).toBe(1)
      expect(nodeA.tip.merkleRoot).toEqual(nodeB.tip.merkleRoot)
    } finally {
      nodeA.close()
      nodeB.close()
    }
  }, 10000)
})
