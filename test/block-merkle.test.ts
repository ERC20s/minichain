import { blockMerkleRoot, createBlock } from "../src/block"
import { Node } from "../src/node"
import { keypairFromSeed, sign } from "../src/crypto/ed25519"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Transaction } from "../src/types/transaction"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

describe("canonical merkle leaves", () => {
  it("yields the same root for the same transaction with reordered keys", () => {
    const a = { sender: "alice", recipient: "bob", amount: 7, nonce: 3 } as Transaction
    // same logical transaction, different key insertion order (what JSON.parse
    // of a peer's payload can hand us)
    const b = JSON.parse('{"nonce":3,"amount":7,"recipient":"bob","sender":"alice"}') as Transaction

    expect(blockMerkleRoot([a])).toEqual(blockMerkleRoot([b]))
    // JSON.stringify, the old leaf encoding, does NOT agree
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b))
  })

  it("ignores an absent optional payload the way signing does", () => {
    const withUndefined = { sender: "alice", recipient: "bob", amount: 1, nonce: 1, payload: undefined } as Transaction
    const without = { sender: "alice", recipient: "bob", amount: 1, nonce: 1 } as Transaction
    expect(blockMerkleRoot([withUndefined])).toEqual(blockMerkleRoot([without]))
  })

  it("changes the root when an amount is tampered with", () => {
    const tx: Transaction = { sender: "alice", recipient: "bob", amount: 1, nonce: 1 }
    const tampered: Transaction = { ...tx, amount: 2 }
    expect(blockMerkleRoot([tx])).not.toEqual(blockMerkleRoot([tampered]))
  })

  it("keeps createBlock and the recomputed root in agreement after a JSON round-trip", () => {
    const blk = createBlock("0x00", 1, [
      { sender: "alice", recipient: "bob", amount: 1, nonce: 1 },
      { sender: "bob", recipient: "carol", amount: 2, nonce: 2, payload: { memo: "hi", tag: 1 } },
    ])
    const roundTripped = JSON.parse(JSON.stringify(blk))
    // this is exactly the check src/node.ts performs on a gossiped block
    expect(blockMerkleRoot(roundTripped.transactions)).toEqual(blk.merkleRoot)
  })

  it("accepts a block whose transaction keys arrive in a different order", async () => {
    const portA = 9401
    const portB = 9402
    const urlA = `ws://127.0.0.1:${portA}`
    const urlB = `ws://127.0.0.1:${portB}`

    const genesis = createBlock("0x00", 0, [])

    const nodeA = new Node(portA, [urlB], genesis)
    const nodeB = new Node(portB, [urlA], genesis)

    const seed = new Uint8Array(32)
    seed[0] = 5
    const kp = keypairFromSeed(seed)

    const blk = createBlock(genesis.merkleRoot, 1, [
      { sender: "alice", recipient: "bob", amount: 4, nonce: 1 },
    ])

    // re-serialize the transaction with the keys in a different order, as a
    // peer or an RPC caller may well send it; the root must still match
    const reordered = {
      ...blk,
      transactions: [JSON.parse('{"nonce":1,"amount":4,"recipient":"bob","sender":"alice"}')],
    }

    const msg = canonicalBlockEncoding({
      parentHash: blk.parentHash,
      height: blk.height,
      timestamp: blk.timestamp,
      merkleRoot: blk.merkleRoot,
      proposerPublicKey: kp.publicKey,
    })
    const sig = sign(msg, kp.secretKey)

    await wait(50)

    nodeA.broadcastBlock(reordered as any, sig, kp.publicKey)

    await wait(200)

    nodeA.close()
    nodeB.close()

    expect(nodeB.tip.height).toBe(1)
    expect(nodeB.tip.merkleRoot).toEqual(blk.merkleRoot)
  }, 2000)
})
