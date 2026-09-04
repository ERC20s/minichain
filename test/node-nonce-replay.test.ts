import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { NonceLedger } from "../src/state/nonces"
import { verifyTransaction } from "../src/tx"
import { Transaction } from "../src/types/transaction"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

function signBlock(blk: Block, keypair: Keypair): Uint8Array {
  const msg = canonicalBlockEncoding({
    parentHash: blk.parentHash,
    height: blk.height,
    timestamp: blk.timestamp,
    merkleRoot: blk.merkleRoot,
    proposerPublicKey: keypair.publicKey,
  })
  return sign(msg, keypair.secretKey)
}

/**
 * A signed transaction is authorised for ever, so authorisation alone does not
 * make it FRESH. These tests pin the per-sender nonce rule that closes the gap:
 * a transaction is accepted only when its nonce is strictly greater than the
 * last nonce the node accepted for that sender, counting earlier transactions in
 * the same block.
 *
 * Every replay below is otherwise perfect — the same signed bytes, so
 * verifyTransaction returns true, the recomputed Merkle root matches, and the
 * proposer's own header signature verifies. Only the ledger can tell them apart.
 */
describe("NonceLedger", () => {
  const alice = accountHex(71)
  const bob = accountHex(72)

  const txOf = (sender: string, nonce: number): Transaction =>
    ({ sender, recipient: "x", amount: 1, nonce } as Transaction)

  it("starts empty and accepts any first nonce, gaps included", () => {
    const ledger = new NonceLedger()
    expect(ledger.size).toBe(0)
    expect(ledger.lastNonce(alice)).toBeUndefined()
    expect(ledger.stage([txOf(alice, 9)])).not.toBeNull()
  })

  it("seeds from the genesis transactions it is built with", () => {
    const ledger = new NonceLedger([txOf(alice, 4), txOf(alice, 2), txOf(bob, 1)])
    expect(ledger.lastNonce(alice)).toBe(4) // the highest, not the last written
    expect(ledger.lastNonce(bob)).toBe(1)
    // a genesis transaction cannot be replayed into block 1
    expect(ledger.stage([txOf(alice, 4)])).toBeNull()
    expect(ledger.stage([txOf(alice, 5)])).not.toBeNull()
  })

  it("stages without writing; commit is what moves the ledger", () => {
    const ledger = new NonceLedger()
    const staged = ledger.stage([txOf(alice, 1)])
    expect(staged).not.toBeNull()
    // the block might still be dropped by a later check, so nothing is written
    expect(ledger.lastNonce(alice)).toBeUndefined()
    ledger.commit(staged)
    expect(ledger.lastNonce(alice)).toBe(1)
    expect(ledger.stage([txOf(alice, 1)])).toBeNull()
  })

  it("rejects a repeat, an equal and a lower nonce within one block", () => {
    const ledger = new NonceLedger()
    expect(ledger.stage([txOf(alice, 1), txOf(alice, 1)])).toBeNull()
    expect(ledger.stage([txOf(alice, 2), txOf(alice, 2)])).toBeNull()
    expect(ledger.stage([txOf(alice, 2), txOf(alice, 1)])).toBeNull()
    // ascending within the block is fine, and only the highest is recorded
    const staged = ledger.stage([txOf(alice, 1), txOf(alice, 2)])
    expect(staged).not.toBeNull()
    ledger.commit(staged)
    expect(ledger.lastNonce(alice)).toBe(2)
  })

  it("keeps senders independent", () => {
    const ledger = new NonceLedger()
    ledger.commit(ledger.stage([txOf(alice, 1), txOf(bob, 1)]))
    expect(ledger.lastNonce(alice)).toBe(1)
    expect(ledger.lastNonce(bob)).toBe(1)
    expect(ledger.stage([txOf(bob, 1)])).toBeNull()
    expect(ledger.stage([txOf(bob, 2)])).not.toBeNull()
  })

  it("refuses a nonce or a sender it cannot compare", () => {
    const ledger = new NonceLedger()
    expect(ledger.stage([txOf(alice, 1.5)])).toBeNull()
    expect(ledger.stage([txOf(alice, -1)])).toBeNull()
    expect(ledger.stage([txOf(alice, NaN)])).toBeNull()
    expect(ledger.stage([{ sender: alice, recipient: "x", amount: 1 } as any])).toBeNull()
    expect(ledger.stage([txOf("", 1)])).toBeNull()
    // an empty block always stages
    expect(ledger.stage([])).not.toBeNull()
  })

  it("never walks a sender backwards, even on a stale commit", () => {
    const ledger = new NonceLedger()
    const stale = ledger.stage([txOf(alice, 1)])
    ledger.commit(ledger.stage([txOf(alice, 5)]))
    ledger.commit(stale)
    expect(ledger.lastNonce(alice)).toBe(5)
  })
})

describe("a node drops a block that replays a transaction", () => {
  const proposer = account(73)
  const genesis = createBlock("0x00", 0, [])

  /** Alice's first transfer: signed once, reused below byte for byte. */
  const aliceOne = signedTx(74, { recipient: "bob", amount: 1, nonce: 1 })
  const aliceTwo = signedTx(74, { recipient: "bob", amount: 1, nonce: 2 })
  const carolOne = signedTx(75, { recipient: "dave", amount: 3, nonce: 1 })

  it("the replay is a valid transaction in every other respect", () => {
    expect(verifyTransaction(aliceOne)).toBe(true)
    // the same object twice: one preimage, one signature, both verify
    const twice = [aliceOne, { ...aliceOne }]
    expect(twice.every((tx) => verifyTransaction(tx))).toBe(true)
    expect(aliceOne.sender).toBe(accountHex(74))
  })

  /** Two connected nodes; blocks are delivered to B one after another. */
  async function session(ports: [number, number]) {
    const [portA, portB] = ports
    // both senders are funded, so every block below is judged on its nonces
    // and not on whether its transfers are affordable
    const opening = funded([74, 75])
    const nodeB = new Node(portB, [], genesis, [], opening)
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)
    await wait(100)
    return {
      tip: () => nodeB.tip,
      /** Broadcast `blk` with a genuine header signature; return B's tip. */
      async send(blk: Block): Promise<Block> {
        nodeA.broadcastBlock(blk, signBlock(blk, proposer), proposer.publicKey)
        await wait(250)
        return nodeB.tip
      },
      async close() {
        nodeA.close(); nodeB.close()
        await wait(20)
      },
    }
  }

  it("accepts a block and then drops one replaying its transaction", async () => {
    const s = await session([9941, 9942])
    try {
      const first = createBlock(blockHash(genesis), 1, [aliceOne])
      let tip = await s.send(first)
      expect(tip.height).toBe(1)

      // the identical signed object, in a well-formed child of the new tip
      const replay = createBlock(blockHash(first), 2, [{ ...aliceOne }])
      tip = await s.send(replay)
      expect(tip.height).toBe(1)
      expect(blockHash(tip)).toBe(blockHash(first))
    } finally {
      await s.close()
    }
  }, 8000)

  it("drops a block carrying the same transaction twice", async () => {
    const s = await session([9951, 9952])
    try {
      const doubled = createBlock(blockHash(genesis), 1, [aliceOne, { ...aliceOne }])
      const tip = await s.send(doubled)
      expect(tip.height).toBe(0)
      expect(blockHash(tip)).toBe(blockHash(genesis))
    } finally {
      await s.close()
    }
  }, 8000)

  it("accepts rising nonces from one sender across blocks", async () => {
    const s = await session([9961, 9962])
    try {
      const first = createBlock(blockHash(genesis), 1, [aliceOne])
      let tip = await s.send(first)
      expect(tip.height).toBe(1)

      const second = createBlock(blockHash(first), 2, [aliceTwo])
      tip = await s.send(second)
      expect(tip.height).toBe(2)
      expect(tip.transactions[0].nonce).toBe(2)
    } finally {
      await s.close()
    }
  }, 8000)

  it("accepts two different senders both at nonce 1", async () => {
    const s = await session([9971, 9972])
    try {
      const blk = createBlock(blockHash(genesis), 1, [aliceOne, carolOne])
      const tip = await s.send(blk)
      expect(tip.height).toBe(1)
      expect(tip.transactions.length).toBe(2)
    } finally {
      await s.close()
    }
  }, 8000)

  it("still accepts a good block after rejecting a replay", async () => {
    const s = await session([9981, 9982])
    try {
      const first = createBlock(blockHash(genesis), 1, [aliceOne])
      let tip = await s.send(first)
      expect(tip.height).toBe(1)

      const replay = createBlock(blockHash(first), 2, [{ ...aliceOne }])
      tip = await s.send(replay)
      expect(tip.height).toBe(1) // dropped, and the ledger was NOT written

      const good = createBlock(blockHash(first), 2, [aliceTwo])
      tip = await s.send(good)
      expect(tip.height).toBe(2)
      expect(blockHash(tip)).toBe(blockHash(good))
    } finally {
      await s.close()
    }
  }, 10000)
})
