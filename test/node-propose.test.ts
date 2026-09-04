import { blockHash, createBlock } from "../src/block"
import { Keypair, keypairFromSeed } from "../src/crypto/ed25519"
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
