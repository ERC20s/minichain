import {
  GENESIS_PARENT_HASH,
  GENESIS_TIMESTAMP,
  blockHash,
  createBlock,
  createGenesisBlock,
} from "../src/block"
import { Keypair, keypairFromSeed } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * The fixed genesis block (src/block.ts, createGenesisBlock).
 *
 * The bug this pins closed: createBlock stamps Date.now() when no timestamp is
 * passed and blockHash covers the timestamp, so `createBlock("genesis", 0, [])`
 * — what examples/run-node.ts ran — gave two nodes started a millisecond apart
 * two DIFFERENT genesis hashes. Block 1 from one of them was dropped by the
 * other at acceptBlock's linkage check (`blk.parentHash === blockHash(this.tip)`)
 * with nothing logged, and the follower stayed at height 0 for ever.
 *
 * test/node-sync.test.ts structurally cannot catch this: it builds ONE genesis
 * object and hands the same reference to both Nodes. The gossip case below
 * therefore builds each node's genesis SEPARATELY, exactly as two `npm run dev`
 * processes do.
 *
 * The gossip ports used below (9191-9192) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

describe("the genesis block is fixed, not stamped", () => {
  it("hashes identically in two independent creations", async () => {
    const first = createGenesisBlock()
    // Enough real time that Date.now() has certainly moved on: a stamped
    // genesis would differ here, a fixed one cannot.
    await wait(5)
    const second = createGenesisBlock()

    expect(second.timestamp).toBe(first.timestamp)
    expect(blockHash(second)).toBe(blockHash(first))
    expect(second).toEqual(first)
  })

  it("pins the header fields every node must agree on", () => {
    const genesis = createGenesisBlock()

    expect(GENESIS_PARENT_HASH).toBe("genesis")
    expect(GENESIS_TIMESTAMP).toBe(0)
    expect(genesis.parentHash).toBe(GENESIS_PARENT_HASH)
    expect(genesis.height).toBe(0)
    expect(genesis.transactions).toEqual([])

    // acceptBlock's timestamp rule reads the tip's stamp as the floor for the
    // next block, so genesis must carry a real, non-negative, safe integer.
    expect(typeof genesis.timestamp).toBe("number")
    expect(Number.isSafeInteger(genesis.timestamp)).toBe(true)
    expect(genesis.timestamp).toBeGreaterThanOrEqual(0)
  })

  it("carries opening transactions when asked, and stays deterministic", () => {
    const opening = [signedTx(81, { recipient: accountHex(82), amount: 10, nonce: 1 })]
    const a = createGenesisBlock(opening)
    const b = createGenesisBlock(opening)

    expect(a.transactions.length).toBe(1)
    expect(blockHash(a)).toBe(blockHash(b))
    // ...and a different opening list is a different chain, by design
    expect(blockHash(a)).not.toBe(blockHash(createGenesisBlock()))
  })

  it("shows why a stamped genesis forked the network", () => {
    // The old form, made explicit: same parentHash, same height, same (empty)
    // transaction list — two clocks, two chains.
    const early = createBlock(GENESIS_PARENT_HASH, 0, [], 1000)
    const late = createBlock(GENESIS_PARENT_HASH, 0, [], 2000)

    expect(early.merkleRoot).toBe(late.merkleRoot)
    expect(blockHash(early)).not.toBe(blockHash(late))
    // and neither is the fixed genesis a node builds today
    expect(blockHash(createGenesisBlock())).not.toBe(blockHash(early))
  })
})

describe("two nodes built from their OWN genesis share one chain", () => {
  const alice = kp(11)
  const bob = kp(22)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]

  const sender = accountHex(81)
  const opening = funded([81])

  it("accepts a minted block over real gossip", async () => {
    // Each node builds its own genesis object, as two separate processes do.
    const genesisB = createGenesisBlock()
    const nodeB = new Node(9191, [], genesisB, validators, opening)
    await wait(60)
    const genesisA = createGenesisBlock()
    const nodeA = new Node(9192, ["ws://127.0.0.1:9191"], genesisA, validators, opening)
    await wait(120)

    try {
      // The two nodes never shared an object, yet they must hold one tip.
      expect(blockHash(nodeA.tip)).toBe(blockHash(nodeB.tip))

      // Who may propose height 1 is fixed by that shared tip.
      const elected = selectValidator(validators, proposerSeed(genesisA))
      expect(elected).toBe(selectValidator(validators, proposerSeed(genesisB)))
      const proposer = publicKeyToHex(alice.publicKey) === elected ? alice : bob

      const tx = signedTx(81, { recipient: "carol", amount: 9, nonce: 1 })
      expect(nodeA.submitTransaction(tx).admitted).toBe(true)
      await wait(200)

      const minted = nodeA.proposeBlock(proposer.secretKey, proposer.publicKey)
      expect(minted).not.toBeNull()
      expect(minted!.parentHash).toBe(blockHash(genesisB))
      await wait(300)

      // The assertion the old code could never satisfy: B, built from ITS own
      // genesis, took A's block instead of silently staying at height 0.
      expect(nodeB.tip.height).toBe(1)
      expect(blockHash(nodeB.tip)).toBe(blockHash(minted!))
      expect(nodeB.balances.balanceOf(sender)).toBe(1000000 - 9)
      expect(nodeB.nonces.lastNonce(sender)).toBe(1)
    } finally {
      nodeA.close()
      nodeB.close()
      await wait(20)
    }
  }, 15000)
})
