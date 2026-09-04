import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { BalanceLedger } from "../src/state/balances"
import { Mempool, transactionId } from "../src/state/mempool"
import { NonceLedger } from "../src/state/nonces"
import { Transaction } from "../src/types/transaction"
import { account, accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * The pending-transaction pool (src/state/mempool.ts) and its wiring into the
 * gossip "tx" frame (src/node.ts).
 *
 * What is pinned here:
 *  - admission runs the SAME rules a block is judged by: signature, a nonce
 *    strictly above what the node has accepted, and a balance that covers the
 *    amount together with the sender's other pending transfers;
 *  - identity is the hex sha256 of the transaction's Merkle leaf, so the same
 *    transfer is one entry however it is spelled;
 *  - the pool is bounded, refusing rather than evicting;
 *  - a transaction is relayed EXACTLY once, on first admission;
 *  - an accepted block empties out what it committed and what it made stale;
 *  - nothing in this path moves the tip.
 *
 * The gossip ports used below (9121-9152) are used by no other test file.
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

/** A pool over hand-made ledgers, so the unit cases need no sockets. */
function pool(opening: Record<string, number>, options?: { maxSize?: number; maxPerSender?: number }) {
  const nonces = new NonceLedger()
  const balances = new BalanceLedger([], opening)
  return { pool: new Mempool(nonces, balances, options), nonces, balances }
}

describe("Mempool", () => {
  const alice = accountHex(81)
  const bob = accountHex(82)

  it("admits a signed, fresh, affordable transaction exactly once", () => {
    const { pool: mp } = pool({ [alice]: 100 })
    const tx = signedTx(81, { recipient: "bob", amount: 10, nonce: 1 })

    const first = mp.add(tx)
    expect(first.admitted).toBe(true)
    expect(first.reason).toBe("admitted")
    expect(first.id).toBe(transactionId(tx))
    expect(mp.size).toBe(1)
    expect(mp.has(first.id as string)).toBe(true)
    expect(mp.ids()).toEqual([transactionId(tx)])

    // the same transfer again — a fresh object with the same bytes — is known
    const again = mp.add({ ...tx })
    expect(again.admitted).toBe(false)
    expect(again.reason).toBe("duplicate")
    expect(again.id).toBe(first.id)
    expect(mp.size).toBe(1)
  })

  it("refuses an unsigned, a forged and a malformed transaction", () => {
    const { pool: mp } = pool({ [alice]: 100 })
    const good = signedTx(81, { recipient: "bob", amount: 10, nonce: 1 })

    const unsigned = { ...good } as Transaction
    delete (unsigned as { signature?: string }).signature
    expect(mp.add(unsigned).reason).toBe("unauthorised")

    // the signature is real, the body is not the one it covers
    expect(mp.add({ ...good, amount: 11 }).reason).toBe("unauthorised")

    // another account's signature under Alice's name
    const carol = signedTx(82, { recipient: "bob", amount: 10, nonce: 1 })
    expect(mp.add({ ...good, signature: carol.signature }).reason).toBe("unauthorised")

    expect(mp.add(null as unknown as Transaction).reason).toBe("malformed")
    expect(mp.add({ sender: alice } as unknown as Transaction).reason).toBe("unauthorised")
    expect(mp.size).toBe(0)
  })

  it("refuses a replay and a second transaction at a queued nonce", () => {
    const { pool: mp, nonces } = pool({ [alice]: 1000 })
    nonces.commit(nonces.stage([{ sender: alice, recipient: "x", amount: 1, nonce: 5 } as Transaction]))

    expect(mp.add(signedTx(81, { recipient: "bob", amount: 1, nonce: 5 })).reason).toBe("replayed")
    expect(mp.add(signedTx(81, { recipient: "bob", amount: 1, nonce: 4 })).reason).toBe("replayed")

    expect(mp.add(signedTx(81, { recipient: "bob", amount: 1, nonce: 6 })).admitted).toBe(true)
    // a DIFFERENT transaction at a nonce already queued: only one can ever land
    expect(mp.add(signedTx(81, { recipient: "carol", amount: 2, nonce: 6 })).reason).toBe("replayed")
    expect(mp.size).toBe(1)
  })

  it("counts what a sender already has pending when judging affordability", () => {
    const { pool: mp } = pool({ [alice]: 100 })

    expect(mp.add(signedTx(81, { recipient: "bob", amount: 60, nonce: 1 })).admitted).toBe(true)
    expect(mp.pendingAmount(alice)).toBe(60)
    // 60 queued + 50 more is over the 100 this account holds
    expect(mp.add(signedTx(81, { recipient: "bob", amount: 50, nonce: 2 })).reason).toBe("unaffordable")
    // 40 fits exactly
    expect(mp.add(signedTx(81, { recipient: "bob", amount: 40, nonce: 2 })).admitted).toBe(true)
    expect(mp.size).toBe(2)

    // an account that was never credited can afford nothing
    expect(mp.add(signedTx(82, { recipient: "bob", amount: 1, nonce: 1 })).reason).toBe("unaffordable")
  })

  it("is bounded, and refuses rather than evicting", () => {
    const { pool: mp } = pool({ [alice]: 1000000, [bob]: 1000000 }, { maxSize: 3, maxPerSender: 2 })

    expect(mp.add(signedTx(81, { recipient: "x", amount: 1, nonce: 1 })).admitted).toBe(true)
    expect(mp.add(signedTx(81, { recipient: "x", amount: 1, nonce: 2 })).admitted).toBe(true)
    // Alice's third hits the per-sender cap; the two already admitted stay
    expect(mp.add(signedTx(81, { recipient: "x", amount: 1, nonce: 3 })).reason).toBe("sender-full")
    expect(mp.pendingFor(alice).length).toBe(2)

    expect(mp.add(signedTx(82, { recipient: "x", amount: 1, nonce: 1 })).admitted).toBe(true)
    expect(mp.size).toBe(3)
    // and now the whole pool is full, for everyone
    expect(mp.add(signedTx(82, { recipient: "x", amount: 1, nonce: 2 })).reason).toBe("pool-full")
    expect(mp.size).toBe(3)
  })

  it("hands a proposer transactions in ascending nonce order per sender", () => {
    const { pool: mp } = pool({ [alice]: 1000, [bob]: 1000 })
    const a2 = signedTx(81, { recipient: "x", amount: 1, nonce: 2 })
    const a1 = signedTx(81, { recipient: "x", amount: 1, nonce: 1 })
    const b1 = signedTx(82, { recipient: "x", amount: 1, nonce: 1 })
    // admitted out of order on purpose
    mp.add(a2)
    mp.add(a1)
    mp.add(b1)

    const taken = mp.take(10)
    expect(taken.length).toBe(3)
    const aliceNonces = taken.filter((tx) => tx.sender === alice).map((tx) => tx.nonce)
    expect(aliceNonces).toEqual([1, 2])
    expect(mp.take(2).length).toBe(2)
    expect(mp.take(0)).toEqual([])
    // take() removes nothing
    expect(mp.size).toBe(3)
    expect(mp.pendingFor(alice).map((tx) => tx.nonce)).toEqual([1, 2])
  })

  it("drops what a block committed and what the block made stale", () => {
    const { pool: mp, nonces } = pool({ [alice]: 1000 })
    const a1 = signedTx(81, { recipient: "x", amount: 1, nonce: 1 })
    const a2 = signedTx(81, { recipient: "x", amount: 1, nonce: 2 })
    const a3 = signedTx(81, { recipient: "x", amount: 1, nonce: 3 })
    mp.add(a1)
    mp.add(a2)
    mp.add(a3)
    expect(mp.size).toBe(3)

    // a block carrying a2 lands: the ledger moves first, exactly as in src/node.ts
    nonces.commit(nonces.stage([a2]))
    const removed = mp.drop([a2])

    // a2 went because it landed; a1 went because nonce 1 can never land now
    expect(removed).toBe(2)
    expect(mp.size).toBe(1)
    expect(mp.pendingFor(alice).map((tx) => tx.nonce)).toEqual([3])
    expect(mp.has(transactionId(a3))).toBe(true)

    // dropping something that was never pooled is a no-op
    expect(mp.drop([a1])).toBe(0)
    expect(mp.drop([null as unknown as Transaction])).toBe(0)
  })
})

describe("a node pools and relays gossiped transactions", () => {
  const proposer = account(83)
  const genesis = createBlock("0x00", 0, [])
  const alice = accountHex(81)

  /**
   * Three nodes in a line: A -> B -> C. A transaction submitted at A can only
   * reach C by being RELAYED through B, which is what the relay-once rule is
   * about.
   */
  async function session(ports: [number, number, number]) {
    const [portA, portB, portC] = ports
    const opening = funded([81, 82])
    const nodeC = new Node(portC, [], genesis, [], opening)
    await wait(60)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portC}`], genesis, [], opening)
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)
    await wait(120)
    return {
      a: nodeA,
      b: nodeB,
      c: nodeC,
      async sendBlock(blk: Block): Promise<void> {
        nodeA.broadcastBlock(blk, signBlock(blk, proposer), proposer.publicKey)
        await wait(250)
      },
      async close() {
        nodeA.close()
        nodeB.close()
        nodeC.close()
        await wait(20)
      },
    }
  }

  it("relays an admitted transaction across the mesh, and only once", async () => {
    const s = await session([9121, 9122, 9123])
    try {
      const tx = signedTx(81, { recipient: "bob", amount: 5, nonce: 1 })
      const submitted = s.a.submitTransaction(tx)
      expect(submitted.admitted).toBe(true)
      await wait(300)

      expect(s.a.mempool.size).toBe(1)
      expect(s.b.mempool.size).toBe(1)
      // it only got to C because B relayed it
      expect(s.c.mempool.size).toBe(1)
      expect(s.c.mempool.ids()).toEqual([transactionId(tx)])

      // the same transaction again is already known everywhere: no pool grows,
      // and nothing bounces around the mesh
      s.a.mempool.clear()
      const resubmitted = s.a.submitTransaction({ ...tx })
      expect(resubmitted.admitted).toBe(true)
      await wait(300)
      expect(s.b.mempool.size).toBe(1)
      expect(s.c.mempool.size).toBe(1)

      // and no tip moved: the pool is not a second consensus path
      expect(s.b.tip.height).toBe(0)
      expect(s.c.tip.height).toBe(0)
    } finally {
      await s.close()
    }
  }, 15000)

  it("does not pool or relay an unsigned or unaffordable transaction", async () => {
    const s = await session([9131, 9132, 9133])
    try {
      const good = signedTx(81, { recipient: "bob", amount: 5, nonce: 1 })
      const unsigned = { ...good } as Transaction
      delete (unsigned as { signature?: string }).signature
      expect(s.a.submitTransaction(unsigned).admitted).toBe(false)

      // signed, fresh, and far beyond what the account holds
      const broke = signedTx(82, { recipient: "bob", amount: 10000000, nonce: 1 })
      expect(s.a.submitTransaction(broke).reason).toBe("unaffordable")

      await wait(300)
      expect(s.a.mempool.size).toBe(0)
      expect(s.b.mempool.size).toBe(0)
      expect(s.c.mempool.size).toBe(0)
    } finally {
      await s.close()
    }
  }, 15000)

  it("empties the pool of what an accepted block committed", async () => {
    const s = await session([9141, 9142, 9143])
    try {
      const tx = signedTx(81, { recipient: "bob", amount: 5, nonce: 1 })
      const later = signedTx(81, { recipient: "bob", amount: 5, nonce: 9 })
      s.a.submitTransaction(tx)
      s.a.submitTransaction(later)
      await wait(300)
      expect(s.b.mempool.size).toBe(2)

      const blk = createBlock(blockHash(genesis), 1, [tx])
      await s.sendBlock(blk)

      expect(s.b.tip.height).toBe(1)
      // the committed transaction is gone; the higher-nonced one is still pending
      expect(s.b.mempool.has(transactionId(tx))).toBe(false)
      expect(s.b.mempool.has(transactionId(later))).toBe(true)
      expect(s.b.mempool.size).toBe(1)
      expect(s.b.balances.balanceOf(alice)).toBe(1000000 - 5)

      // and a transaction the block made stale can no longer be admitted
      expect(s.b.mempool.add({ ...tx }).reason).toBe("replayed")
    } finally {
      await s.close()
    }
  }, 15000)

  it("ignores a tx frame that is not a transaction at all", async () => {
    const s = await session([9151, 9152, 9153])
    try {
      const junk = new TextEncoder().encode("{not json")
      s.a.gossip.broadcast("tx", junk)
      s.a.gossip.broadcast("tx", new TextEncoder().encode(JSON.stringify([1, 2, 3])))
      s.a.gossip.broadcast("tx", new TextEncoder().encode(JSON.stringify({ sender: alice })))
      await wait(300)

      expect(s.b.mempool.size).toBe(0)
      expect(s.c.mempool.size).toBe(0)
      expect(s.b.tip.height).toBe(0)
    } finally {
      await s.close()
    }
  }, 15000)
})
