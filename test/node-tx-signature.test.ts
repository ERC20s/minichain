import { Block, blockHash, createBlock, transactionLeaves } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, sign } from "../src/crypto/ed25519"
import { merkleRoot } from "../src/merkle"
import { Node } from "../src/node"
import { signTransaction, verifyTransaction } from "../src/tx"
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
 * A block is dropped when any transaction in it is not authorised by its sender.
 *
 * Every other check in src/node.ts passes for the forgeries below: the height and
 * parentHash link correctly, the recomputed Merkle root matches the header, and
 * the proposer's own ed25519 header signature verifies — the proposer really did
 * build these blocks. What they lack is the sender's consent.
 */
describe("a node refuses a block carrying an unauthorised transaction", () => {
  const proposer = account(61)
  const alice = account(62)
  const mallory = account(63)

  const genesis = createBlock("0x00", 0, [])

  const honestTxs: Transaction[] = [
    signedTx(62, { recipient: "bob", amount: 1, nonce: 1 }),
    signedTx(64, { recipient: "carol", amount: 2, nonce: 1 }),
  ]
  const honest = createBlock(blockHash(genesis), 1, honestTxs)

  /** Mallory signs her own transfer, then rewrites the sender to Alice. */
  const forgedTx: Transaction = {
    ...signTransaction(
      { recipient: "mallory", amount: 1000000, nonce: 1 },
      mallory.secretKey
    ),
    sender: accountHex(62),
  }
  /** A block the proposer really assembled around that forgery. */
  const forgedBlock = createBlock(blockHash(genesis), 1, [
    honestTxs[0],
    forgedTx,
  ])

  /** An honest transaction with its amount rewritten after signing. */
  const tamperedTx: Transaction = { ...honestTxs[0], amount: 999 }
  const tamperedBlock = createBlock(blockHash(genesis), 1, [tamperedTx])

  it("the forgeries are well-formed everywhere except the signature", () => {
    expect(alice.publicKey.length).toBe(32)
    // the block commits to exactly these transactions: the root check passes
    expect(merkleRoot(transactionLeaves(forgedBlock.transactions))).toBe(
      forgedBlock.merkleRoot
    )
    expect(merkleRoot(transactionLeaves(tamperedBlock.transactions))).toBe(
      tamperedBlock.merkleRoot
    )
    // and only the per-transaction check can tell them apart
    expect(verifyTransaction(honestTxs[0])).toBe(true)
    expect(verifyTransaction(forgedTx)).toBe(false)
    expect(verifyTransaction(tamperedTx)).toBe(false)
    expect(forgedTx.sender).toBe(accountHex(62))
  })

  async function deliver(blk: Block, ports: [number, number]) {
    const [portA, portB] = ports
    const nodeB = new Node(portB, [], genesis)
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis)

    const sig = signBlock(blk, proposer) // a genuine header signature
    await wait(100)
    nodeA.broadcastBlock(blk, sig, proposer.publicKey)
    await wait(250)

    const tip = nodeB.tip
    nodeA.close(); nodeB.close()
    await wait(20)
    return tip
  }

  it("accepts a block whose transactions are all signed by their senders", async () => {
    const tip = await deliver(honest, [9901, 9902])
    expect(tip.height).toBe(1)
    expect(tip.transactions.length).toBe(2)
  }, 4000)

  it("drops a block containing a transaction signed by another key", async () => {
    const tip = await deliver(forgedBlock, [9911, 9912])
    expect(tip.height).toBe(0)
    expect(blockHash(tip)).toBe(blockHash(genesis))
  }, 4000)

  it("drops a block whose transaction was edited after signing", async () => {
    const tip = await deliver(tamperedBlock, [9921, 9922])
    expect(tip.height).toBe(0)
    expect(blockHash(tip)).toBe(blockHash(genesis))
  }, 4000)

  it("drops a block carrying an unsigned transaction", async () => {
    // createBlock refuses to build this, so a forger has to assemble it by hand:
    // the leaf format needs a signature, so the root cannot even be recomputed.
    const unsigned: Transaction = {
      sender: accountHex(62),
      recipient: "mallory",
      amount: 1000000,
      nonce: 1,
    }
    const handmade: Block = { ...honest, transactions: [unsigned] }
    expect(() => transactionLeaves(handmade.transactions)).toThrow()

    const tip = await deliver(handmade, [9931, 9932])
    expect(tip.height).toBe(0)
    expect(blockHash(tip)).toBe(blockHash(genesis))
  }, 4000)
})
