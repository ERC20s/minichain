import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { BalanceLedger } from "../src/state/balances"
import { verifyTransaction } from "../src/tx"
import { Transaction } from "../src/types/transaction"
import { account, accountHex, signedTx } from "./helpers/signed-tx"

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
 * A signature proves consent and a rising nonce proves freshness; neither proves
 * the money exists. These tests pin the solvency rule that closes the last hole
 * in block acceptance: a transaction is accepted only when its sender's running
 * balance covers its amount, counting transactions earlier in the same block.
 *
 * Every rejected block below is otherwise perfect — signed transactions that
 * verify, nonces that rise, a recomputed Merkle root that matches and a genuine
 * header signature. Only the balance ledger can tell them apart.
 */
describe("BalanceLedger", () => {
  const alice = accountHex(81)
  const bob = accountHex(82)
  const carol = accountHex(83)

  const txOf = (sender: string, recipient: string, amount: number): Transaction =>
    ({ sender, recipient, amount, nonce: 1 } as Transaction)

  it("starts empty: an unknown account holds nothing and can spend nothing", () => {
    const ledger = new BalanceLedger()
    expect(ledger.size).toBe(0)
    expect(ledger.balanceOf(alice)).toBe(0)
    expect(ledger.stage([txOf(alice, bob, 1)])).toBeNull()
    // a zero-amount transfer is affordable from an empty account
    expect(ledger.stage([txOf(alice, bob, 0)])).not.toBeNull()
  })

  it("opens with the balances it is constructed with", () => {
    const ledger = new BalanceLedger([], { [alice]: 10 })
    expect(ledger.balanceOf(alice)).toBe(10)
    expect(ledger.stage([txOf(alice, bob, 10)])).not.toBeNull()
    expect(ledger.stage([txOf(alice, bob, 11)])).toBeNull()
    // a Map is accepted as well as a plain object
    expect(new BalanceLedger([], new Map([[alice, 3]])).balanceOf(alice)).toBe(3)
  })

  it("mints from genesis: a genesis transaction credits, and debits nobody", () => {
    const ledger = new BalanceLedger([txOf(alice, bob, 7)])
    expect(ledger.balanceOf(bob)).toBe(7)
    expect(ledger.balanceOf(alice)).toBe(0) // genesis mints; it does not overdraw
    expect(ledger.stage([txOf(bob, carol, 7)])).not.toBeNull()
    expect(ledger.stage([txOf(bob, carol, 8)])).toBeNull()
  })

  it("stages without writing; commit is what moves the ledger", () => {
    const ledger = new BalanceLedger([], { [alice]: 5 })
    const staged = ledger.stage([txOf(alice, bob, 5)])
    expect(staged).not.toBeNull()
    // the block might still be dropped by a later check, so nothing is written
    expect(ledger.balanceOf(alice)).toBe(5)
    expect(ledger.balanceOf(bob)).toBe(0)
    ledger.commit(staged)
    expect(ledger.balanceOf(alice)).toBe(0)
    expect(ledger.balanceOf(bob)).toBe(5)
    expect(ledger.stage([txOf(alice, bob, 1)])).toBeNull()
  })

  it("refuses a block that overdraws its sender across two transactions", () => {
    const ledger = new BalanceLedger([], { [alice]: 10 })
    // 6 + 6 from a balance of 10: each is affordable alone, the pair is not
    expect(ledger.stage([txOf(alice, bob, 6), txOf(alice, carol, 6)])).toBeNull()
    expect(ledger.stage([txOf(alice, bob, 6), txOf(alice, carol, 4)])).not.toBeNull()
    // and money received earlier in the same block is spendable
    expect(ledger.stage([txOf(alice, bob, 10), txOf(bob, carol, 10)])).not.toBeNull()
    expect(ledger.stage([txOf(alice, bob, 10), txOf(bob, carol, 11)])).toBeNull()
  })

  it("treats a self-transfer as a no-op the sender must still afford", () => {
    const ledger = new BalanceLedger([], { [alice]: 4 })
    expect(ledger.stage([txOf(alice, alice, 5)])).toBeNull()
    ledger.commit(ledger.stage([txOf(alice, alice, 4)]))
    expect(ledger.balanceOf(alice)).toBe(4) // debited then credited: unchanged
  })

  it("refuses a credit that would leave exact integer range", () => {
    const huge = Number.MAX_SAFE_INTEGER
    const ledger = new BalanceLedger([], { [alice]: huge, [bob]: 10 })
    expect(ledger.balanceOf(alice)).toBe(huge)
    // bob would hold MAX_SAFE_INTEGER + 10, where addition stops being exact
    expect(ledger.stage([txOf(alice, bob, huge)])).toBeNull()
    expect(ledger.stage([txOf(alice, carol, huge)])).not.toBeNull()
  })

  it("refuses an amount, sender or recipient it cannot read", () => {
    const ledger = new BalanceLedger([], { [alice]: 100 })
    expect(ledger.stage([txOf(alice, bob, 1.5)])).toBeNull()
    expect(ledger.stage([txOf(alice, bob, -1)])).toBeNull()
    expect(ledger.stage([txOf(alice, bob, NaN)])).toBeNull()
    expect(ledger.stage([txOf(alice, bob, Infinity)])).toBeNull()
    expect(ledger.stage([txOf(alice, "", 1)])).toBeNull()
    expect(ledger.stage([txOf("", bob, 1)])).toBeNull()
    expect(ledger.stage([{ sender: alice, recipient: bob } as any])).toBeNull()
    // an empty block always stages
    expect(ledger.stage([])).not.toBeNull()
  })

  it("refuses a staged batch that no longer matches the ledger", () => {
    const ledger = new BalanceLedger([], { [alice]: 10 })
    const stale = ledger.stage([txOf(alice, bob, 10)])
    ledger.commit(ledger.stage([txOf(alice, carol, 10)]))
    expect(ledger.balanceOf(carol)).toBe(10)
    // committing the stale batch would pay bob out of money already spent
    ledger.commit(stale)
    expect(ledger.balanceOf(bob)).toBe(0)
    expect(ledger.balanceOf(alice)).toBe(0)
    // a null batch (nothing was staged) is a no-op, never a throw
    ledger.commit(null)
    expect(ledger.balanceOf(carol)).toBe(10)
  })
})

describe("a node drops a block it cannot pay for", () => {
  const proposer = account(84)
  const alice = accountHex(85)
  const bob = accountHex(86)
  const genesis = createBlock("0x00", 0, [])

  /** Alice opens with exactly 10 coins on every node in these tests. */
  const opening = { [alice]: 10 }

  const spendFour = signedTx(85, { recipient: bob, amount: 4, nonce: 1 })
  const spendSix = signedTx(85, { recipient: bob, amount: 6, nonce: 2 })
  const spendAHundred = signedTx(85, { recipient: bob, amount: 100, nonce: 2 })
  /** Money from nowhere: a perfect transaction from an account holding zero. */
  const fromNothing = signedTx(87, { recipient: bob, amount: 1000000000, nonce: 1 })

  it("the unaffordable transactions are valid in every other respect", () => {
    expect(verifyTransaction(spendAHundred)).toBe(true)
    expect(verifyTransaction(fromNothing)).toBe(true)
    expect(fromNothing.sender).toBe(accountHex(87))
  })

  /** Two connected nodes; blocks are delivered to B one after another. */
  async function session(ports: [number, number]) {
    const [portA, portB] = ports
    const nodeB = new Node(portB, [], genesis, [], opening)
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)
    await wait(100)
    return {
      balances: () => nodeB.balances,
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

  it("accepts an affordable transfer and moves the balances with the tip", async () => {
    const s = await session([9401, 9402])
    try {
      const first = createBlock(blockHash(genesis), 1, [spendFour])
      const tip = await s.send(first)
      expect(tip.height).toBe(1)
      expect(s.balances().balanceOf(alice)).toBe(6)
      expect(s.balances().balanceOf(bob)).toBe(4)
    } finally {
      await s.close()
    }
  }, 8000)

  it("drops a block spending more than the sender holds and keeps its tip", async () => {
    const s = await session([9411, 9412])
    try {
      const blk = createBlock(blockHash(genesis), 1, [spendAHundred])
      const tip = await s.send(blk)
      expect(tip.height).toBe(0)
      expect(blockHash(tip)).toBe(blockHash(genesis))
      // nothing was written: the sender still holds its opening balance
      expect(s.balances().balanceOf(alice)).toBe(10)
      expect(s.balances().balanceOf(bob)).toBe(0)
    } finally {
      await s.close()
    }
  }, 8000)

  it("drops a block minting from an account that was never credited", async () => {
    const s = await session([9421, 9422])
    try {
      const blk = createBlock(blockHash(genesis), 1, [fromNothing])
      const tip = await s.send(blk)
      expect(tip.height).toBe(0)
      expect(s.balances().balanceOf(bob)).toBe(0)
    } finally {
      await s.close()
    }
  }, 8000)

  it("drops a block whose two transfers overdraw one sender together", async () => {
    const s = await session([9431, 9432])
    try {
      // 4 + 6 is exactly affordable; 4 + 7 is not, and the pair stands or falls
      // as one block
      const overdraft = createBlock(blockHash(genesis), 1, [
        spendFour,
        signedTx(85, { recipient: bob, amount: 7, nonce: 2 }),
      ])
      const tip = await s.send(overdraft)
      expect(tip.height).toBe(0)
      expect(s.balances().balanceOf(alice)).toBe(10)
    } finally {
      await s.close()
    }
  }, 8000)

  it("still accepts a good block after rejecting an unaffordable one", async () => {
    const s = await session([9441, 9442])
    try {
      const first = createBlock(blockHash(genesis), 1, [spendFour])
      let tip = await s.send(first)
      expect(tip.height).toBe(1)

      const broke = createBlock(blockHash(first), 2, [spendAHundred])
      tip = await s.send(broke)
      expect(tip.height).toBe(1) // dropped, and no balance was written

      const good = createBlock(blockHash(first), 2, [spendSix])
      tip = await s.send(good)
      expect(tip.height).toBe(2)
      expect(blockHash(tip)).toBe(blockHash(good))
      expect(s.balances().balanceOf(alice)).toBe(0)
      expect(s.balances().balanceOf(bob)).toBe(10)
    } finally {
      await s.close()
    }
  }, 10000)
})
