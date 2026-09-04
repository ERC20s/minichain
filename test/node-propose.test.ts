import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, keypairFromSeed, sign } from "../src/crypto/ed25519"
import { MAX_BLOCK_TRANSACTIONS, Node } from "../src/node"
import { transactionId } from "../src/state/mempool"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * Block production (src/node.ts, Node.proposeBlock).
 *
 * Thirteen cycles hardened what a node ACCEPTS and nothing on this chain ever
 * produced a block: a gossiped transfer was validated, pooled, relayed — and
 * stayed pooled for ever. What is pinned here:
 *
 *  - the stake-elected key mints a block carrying pooled transactions, the tip
 *    moves, the nonce and balance ledgers commit and the pool drains;
 *  - a key that is not elected for the current tip mints nothing at all, and
 *    nothing it would have signed reaches the wire;
 *  - an empty pool mints nothing unless allowEmpty is asked for;
 *  - a minted block is stamped no earlier than its parent even when the node's
 *    own clock is behind it — the rule acceptBlock enforces;
 *  - a minted block is judged by acceptBlock, the SAME path a gossiped block
 *    takes, and a second node accepts it over gossip.
 *
 * The gossip ports used below (9171-9183) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

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

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

describe("Node.proposeBlock mints from its own mempool", () => {
  const alice = kp(11)
  const bob = kp(22)
  const outsider = kp(33)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]

  const genesis = createBlock("0x00", 0, [])

  // Who may propose height 1 is fixed by the tip: seed = "pos:" || blockHash(genesis).
  const elected = selectValidator(validators, proposerSeed(genesis))
  const proposer = publicKeyToHex(alice.publicKey) === elected ? alice : bob
  const notProposer = proposer === alice ? bob : alice

  // The accounts that send the transfers below (see test/helpers/signed-tx.ts).
  const sender = accountHex(81)
  const opening = funded([81, 82])

  it("mints a block carrying pooled transactions, moves the tip and drains the pool", async () => {
    const node = new Node(9171, [], genesis, validators, opening)
    try {
      const first = signedTx(81, { recipient: "carol", amount: 5, nonce: 1 })
      const second = signedTx(81, { recipient: "carol", amount: 7, nonce: 2 })
      expect(node.submitTransaction(first).admitted).toBe(true)
      expect(node.submitTransaction(second).admitted).toBe(true)
      expect(node.mempool.size).toBe(2)

      const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey)

      expect(blk).not.toBeNull()
      const minted = blk!
      expect(minted.height).toBe(1)
      expect(minted.parentHash).toBe(blockHash(genesis))
      expect(minted.transactions.length).toBe(2)
      // take() hands them over in ascending nonce order, which is what staging needs
      expect(minted.transactions.map((tx) => tx.nonce)).toEqual([1, 2])

      // the tip moved through the ordinary accept path
      expect(node.tip.height).toBe(1)
      expect(blockHash(node.tip)).toBe(blockHash(minted))
      // ...and the ledgers moved with it
      expect(node.nonces.lastNonce(sender)).toBe(2)
      expect(node.balances.balanceOf(sender)).toBe(1000000 - 12)
      // ...and the pool no longer holds what the block committed
      expect(node.mempool.size).toBe(0)
      expect(node.mempool.has(transactionId(first))).toBe(false)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("mints nothing from a key that is not elected for this tip", async () => {
    const node = new Node(9172, [], genesis, validators, opening)
    try {
      const tx = signedTx(81, { recipient: "carol", amount: 5, nonce: 1 })
      expect(node.submitTransaction(tx).admitted).toBe(true)

      // a staked validator that is simply not the one elected here
      expect(node.proposeBlock(notProposer.secretKey, notProposer.publicKey)).toBeNull()
      // and a key with no stake at all
      expect(node.proposeBlock(outsider.secretKey, outsider.publicKey)).toBeNull()

      expect(node.tip.height).toBe(0)
      expect(node.mempool.size).toBe(1)
      expect(node.nonces.lastNonce(sender)).toBeUndefined()
      expect(node.balances.balanceOf(sender)).toBe(1000000)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("mints nothing from an empty pool unless allowEmpty is asked for", async () => {
    const node = new Node(9173, [], genesis, validators, opening)
    try {
      expect(node.mempool.size).toBe(0)
      expect(node.proposeBlock(proposer.secretKey, proposer.publicKey)).toBeNull()
      expect(node.tip.height).toBe(0)

      const empty = node.proposeBlock(proposer.secretKey, proposer.publicKey, { allowEmpty: true })
      expect(empty).not.toBeNull()
      expect(empty!.transactions).toEqual([])
      expect(node.tip.height).toBe(1)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("carries at most maxTransactions, and never more than the pool holds", async () => {
    const node = new Node(9174, [], genesis, validators, opening)
    try {
      node.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 1 }))
      node.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 2 }))
      node.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 3 }))
      expect(node.mempool.size).toBe(3)

      const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey, { maxTransactions: 2 })
      expect(blk).not.toBeNull()
      expect(blk!.transactions.map((tx) => tx.nonce)).toEqual([1, 2])
      // the third is still pending: nonce 3 is still strictly above the ledger
      expect(node.mempool.size).toBe(1)
      expect(MAX_BLOCK_TRANSACTIONS).toBe(256)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("never stamps a block behind its own parent", async () => {
    // A node whose clock is a minute BEHIND the tip. Stamping with that clock
    // would produce a block this node's own acceptBlock refuses.
    const node = new Node(9175, [], genesis, validators, opening, {
      now: () => genesis.timestamp - 60000,
    })
    try {
      node.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 1 }))
      const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey)
      expect(blk).not.toBeNull()
      expect(blk!.timestamp).toBe(genesis.timestamp)
      expect(node.tip.height).toBe(1)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("never broadcasts a block its own rules refuse", async () => {
    const node = new Node(9176, [], genesis, validators, opening)
    try {
      node.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 1 }))
      // A signature made with the WRONG secret key: elected public key, bytes
      // that do not verify. acceptBlock must refuse it, so nothing goes out and
      // the tip stays where it was.
      const sent: Uint8Array[] = []
      const realBroadcast = node.gossip.broadcast
      node.gossip.broadcast = (type, payload, opts) => {
        if (type === "blk") sent.push(payload)
        realBroadcast(type, payload, opts)
      }

      const blk = node.proposeBlock(notProposer.secretKey, proposer.publicKey)
      expect(blk).toBeNull()
      expect(sent.length).toBe(0)
      expect(node.tip.height).toBe(0)
      expect(node.mempool.size).toBe(1)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("gossips a minted block, and a second node accepts it", async () => {
    // B is started first: each node dials its peer once, at construction.
    const nodeB = new Node(9183, [], genesis, validators, opening)
    await wait(60)
    const nodeA = new Node(9182, [`ws://127.0.0.1:9183`], genesis, validators, opening)
    await wait(120)
    try {
      const tx = signedTx(81, { recipient: "carol", amount: 9, nonce: 1 })
      expect(nodeA.submitTransaction(tx).admitted).toBe(true)
      await wait(200)
      expect(nodeB.mempool.size).toBe(1)

      const minted = nodeA.proposeBlock(proposer.secretKey, proposer.publicKey)
      expect(minted).not.toBeNull()
      await wait(300)

      expect(nodeB.tip.height).toBe(1)
      expect(blockHash(nodeB.tip)).toBe(blockHash(minted!))
      expect(nodeB.balances.balanceOf(sender)).toBe(1000000 - 9)
      expect(nodeB.nonces.lastNonce(sender)).toBe(1)
      // B's pool forgot what the block committed
      expect(nodeB.mempool.has(transactionId(tx))).toBe(false)
      expect(nodeB.mempool.size).toBe(0)
    } finally {
      nodeA.close()
      nodeB.close()
      await wait(20)
    }
  }, 15000)
})

/**
 * Liveness: one pending transaction that would not stage must not stop this node
 * minting (src/state/mempool.ts, Mempool.selectForBlock).
 *
 * A block is judged all-or-nothing — BalanceLedger.stage and NonceLedger.stage
 * answer null for the WHOLE list on the first transaction that cannot be applied
 * — so a proposer that handed its raw pool to createBlock lost the entire block
 * to one bad entry, at every tick, for ever. The pool could not heal itself
 * either: drop() only removes what a block committed plus entries whose nonce is
 * no longer above their sender's committed nonce, never one that has become
 * UNAFFORDABLE while its nonce is still fresh.
 *
 * The poisoned state below is not contrived: it is what a sender that gossips
 * nonce 1 to one node and nonce 2 to another produces the moment the first node
 * mints. What is pinned here:
 *
 *  - take() still answers with the poisoned entry (the unfiltered accessor), and
 *    selectForBlock() does not;
 *  - a fresh transfer from another funded account still mints;
 *  - a skipped entry STAYS pending, and lands as soon as it can be paid for —
 *    including in the same block that credits its sender.
 *
 * The gossip ports used below (9177-9178) are in this file's range.
 */
describe("Node.proposeBlock skips a pending transaction that cannot stage", () => {
  const alice = kp(11)
  const bob = kp(22)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]

  const genesis = createBlock("0x00", 0, [])

  /** Whoever the stake election names for this tip. */
  const electedFor = (tip: Block): Keypair =>
    publicKeyToHex(alice.publicKey) === selectValidator(validators, proposerSeed(tip)) ? alice : bob

  // 83 can afford exactly one transfer; 84 is the ordinary funded account.
  const poor = accountHex(83)
  const rich = accountHex(84)
  const opening = { ...funded([83], 100), ...funded([84]) }

  /**
   * Leave the node holding a pending transfer its sender can no longer pay for,
   * by the route gossip actually produces: nonce 2 is pooled while the money is
   * still there, then a block spending the whole balance at nonce 1 arrives.
   */
  function poison(node: Node) {
    const pending = signedTx(83, { recipient: rich, amount: 100, nonce: 2 })
    expect(node.submitTransaction(pending).admitted).toBe(true)

    const spent = signedTx(83, { recipient: rich, amount: 100, nonce: 1 })
    const stamp = Math.max(genesis.timestamp, Date.now())
    const blk = createBlock(blockHash(genesis), 1, [spent], stamp)
    const proposer = electedFor(genesis)
    expect(node.acceptBlock(blk, signBlock(blk, proposer), proposer.publicKey)).toBe(true)

    // drop() removes nothing here: nonce 2 is still strictly above the
    // committed nonce 1, and the sender is now broke.
    expect(node.tip.height).toBe(1)
    expect(node.balances.balanceOf(poor)).toBe(0)
    expect(node.nonces.lastNonce(poor)).toBe(1)
    expect(node.mempool.has(transactionId(pending))).toBe(true)
    expect(node.mempool.size).toBe(1)
    return pending
  }

  it("mints past a pending transfer its sender can no longer afford", async () => {
    const node = new Node(9177, [], genesis, validators, opening)
    try {
      const stuck = poison(node)

      // the raw accessor still hands the poisoned entry over — that was the bug
      expect(node.mempool.take(10).length).toBe(1)
      // the selection used by a proposer refuses it
      expect(node.mempool.selectForBlock(10)).toEqual([])
      // ...so a pool holding ONLY it mints nothing, and no bad block goes out
      expect(node.proposeBlock(electedFor(node.tip).secretKey, electedFor(node.tip).publicKey))
        .toBeNull()

      const fresh = signedTx(84, { recipient: "carol", amount: 5, nonce: 1 })
      expect(node.submitTransaction(fresh).admitted).toBe(true)

      const proposer = electedFor(node.tip)
      const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey)

      expect(blk).not.toBeNull()
      expect(blk!.height).toBe(2)
      expect(blk!.transactions.length).toBe(1)
      expect(blk!.transactions[0].sender).toBe(rich)
      expect(node.tip.height).toBe(2)
      expect(blockHash(node.tip)).toBe(blockHash(blk!))
      expect(node.balances.balanceOf(rich)).toBe(1000000 + 100 - 5)

      // skipping is not dropping: the entry is still pending
      expect(node.mempool.size).toBe(1)
      expect(node.mempool.has(transactionId(stuck))).toBe(true)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("includes a skipped entry in the same block that credits its sender", async () => {
    const node = new Node(9178, [], genesis, validators, opening)
    try {
      const stuck = poison(node)

      // 84 pays 83 exactly what 83 still owes: the running balance the selection
      // carries must see that credit and let the stuck transfer through.
      const credit = signedTx(84, { recipient: poor, amount: 100, nonce: 1 })
      expect(node.submitTransaction(credit).admitted).toBe(true)

      const proposer = electedFor(node.tip)
      const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey)

      expect(blk).not.toBeNull()
      expect(blk!.transactions.length).toBe(2)
      // the credit is ordered first — ascending nonce is what staging needs
      expect(blk!.transactions[0].sender).toBe(rich)
      expect(blk!.transactions[1].sender).toBe(poor)

      expect(node.tip.height).toBe(2)
      expect(node.nonces.lastNonce(poor)).toBe(2)
      expect(node.nonces.lastNonce(rich)).toBe(1)
      expect(node.balances.balanceOf(poor)).toBe(0)
      expect(node.balances.balanceOf(rich)).toBe(1000000 + 100)
      // both landed, so the pool is empty again
      expect(node.mempool.has(transactionId(stuck))).toBe(false)
      expect(node.mempool.size).toBe(0)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)
})
