import { Node } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { merkleRoot } from "../src/merkle"
import { Transaction } from "../src/types/transaction"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
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

function rootOf(txs: Transaction[]): string {
  return merkleRoot(txs.map((tx) => new TextEncoder().encode(JSON.stringify(tx))))
}

/**
 * The attack this file pins down: an honest block whose transaction count leaves
 * an odd layer, relayed with a COPY of its trailing transaction appended. The
 * header is untouched, so the proposer's ed25519 signature still verifies and
 * blockHash() is unchanged; under the old duplicate-the-last-node Merkle rule
 * the padded list recomputed to the same merkleRoot and src/node.ts accepted it.
 */
describe("a padded transaction list cannot forge a block", () => {
  const proposer = kp(44)

  const txs: Transaction[] = [
    { sender: "alice", recipient: "bob", amount: 1, nonce: 1 },
    { sender: "bob", recipient: "carol", amount: 2, nonce: 1 },
    { sender: "carol", recipient: "alice", amount: 3, nonce: 1 },
  ]

  const genesis = createBlock("0x00", 0, [])
  const honest = createBlock(blockHash(genesis), 1, txs)
  /** Same header, one extra copy of the last transaction. */
  const padded: Block = { ...honest, transactions: [...txs, txs[txs.length - 1]] }

  it("the padded list has a different merkle root from the honest list", () => {
    expect(honest.transactions.length % 2).toBe(1) // odd width, the vulnerable shape
    expect(honest.merkleRoot).toBe(rootOf(txs))
    expect(rootOf(padded.transactions)).not.toBe(honest.merkleRoot)
  })

  it("the forgery is otherwise indistinguishable: same header, same block hash, valid signature", () => {
    expect(padded.merkleRoot).toBe(honest.merkleRoot)
    expect(padded.timestamp).toBe(honest.timestamp)
    expect(blockHash(padded)).toBe(blockHash(honest))
    // so the only check that can catch it is the recomputed merkle root
    expect(padded.transactions.length).toBe(honest.transactions.length + 1)
  })

  async function deliver(blk: Block, ports: [number, number]) {
    const [portA, portB] = ports
    const nodeB = new Node(portB, [], genesis)
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis)

    const sig = signBlock(honest, proposer) // header signature, identical for both blocks
    await wait(100)
    nodeA.broadcastBlock(blk, sig, proposer.publicKey)
    await wait(250)

    const tip = nodeB.tip
    nodeA.close(); nodeB.close()
    await wait(20)
    return tip
  }

  it("a node accepts the honest block", async () => {
    const tip = await deliver(honest, [9701, 9702])
    expect(tip.height).toBe(1)
    expect(tip.transactions.length).toBe(3)
  }, 4000)

  it("a node rejects the padded block and keeps its tip", async () => {
    const tip = await deliver(padded, [9711, 9712])
    expect(tip.height).toBe(0)
    expect(tip.transactions.length).toBe(0)
    expect(blockHash(tip)).toBe(blockHash(genesis))
  }, 4000)
})
