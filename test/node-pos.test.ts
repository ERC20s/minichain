import { Node } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { blockHash, createBlock, Block } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { funded, signedTx } from "./helpers/signed-tx"
import { closeAll, waitForPeers, waitUntil } from "./helpers/gossip"

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

describe("Node enforces stake-weighted proposer selection", () => {
  // Two staked validators and one key with no stake at all.
  const alice = kp(11)
  const bob = kp(22)
  const outsider = kp(33)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]

  const genesis = createBlock("0x00", 0, [])

  // The proposer of height 1 is fixed by the tip: seed = "pos:" || blockHash(genesis).
  const elected = selectValidator(validators, proposerSeed(genesis))
  const proposer = publicKeyToHex(alice.publicKey) === elected ? alice : bob
  const notProposer = proposer === alice ? bob : alice

  it("elects exactly one of the staked validators for the block after genesis", () => {
    expect(elected).not.toBeNull()
    expect([publicKeyToHex(alice.publicKey), publicKeyToHex(bob.publicKey)]).toContain(elected)
    expect(publicKeyToHex(proposer.publicKey)).toBe(elected)
    expect(publicKeyToHex(notProposer.publicKey)).not.toBe(elected)
  })

  it("is deterministic: the seed is the tip's block hash, not the wall clock", () => {
    expect(proposerSeed(genesis)).toEqual(proposerSeed(blockHash(genesis)))
    expect(selectValidator(validators, proposerSeed(genesis))).toBe(elected)
    // Order of the caller's array must not matter (see src/validators.ts).
    expect(selectValidator([...validators].reverse(), proposerSeed(genesis))).toBe(elected)
  })

  it("is unchanged by slot rotation at round 0", () => {
    // proposerSeed grew a second argument, the proposer ROUND (see
    // test/node-proposer-rotation.test.ts). Round 0 — a block stamped inside
    // one slot of its parent, which is every block on a healthy chain — must
    // still be byte-for-byte the seed this chain always used, so no existing
    // block, test vector or election moves.
    expect(proposerSeed(genesis, 0)).toEqual(proposerSeed(genesis))
    expect(selectValidator(validators, proposerSeed(genesis, 0))).toBe(elected)
    // A later slot is a different seed, and may elect somebody else — that is
    // what stops one offline validator halting the chain.
    expect(proposerSeed(genesis, 1)).not.toEqual(proposerSeed(genesis))
  })

  /**
   * A -> B -> C. Only B is configured with the validator set. C hears a block
   * only if B re-broadcast it, so C's tip is the witness for "not propagated".
   */
  async function relay(signer: Keypair, ports: [number, number, number]) {
    const [portA, portB, portC] = ports
    // account 12 sends the transfer in the block below, so every node on the
    // path opens with it funded — an unaffordable transfer is dropped for
    // insolvency, which would hide what these tests are about
    const opening = funded([12])
    const nodeC = new Node(portC, [], genesis, [], opening)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portC}`], genesis, validators, opening)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)

    // Stamped at genesis, so the block sits in proposer round 0 — the round
    // `elected` was computed for — however long the run has taken.
    const blk = createBlock(blockHash(genesis), 1, [
      signedTx(12, { recipient: "bob", amount: 1, nonce: 1 }),
    ], genesis.timestamp)
    const sig = signBlock(blk, signer)

    try {
      // Broadcast only once both links on the path are open, so a slow dial under
      // a loaded test run cannot pass for "not propagated".
      await waitForPeers(nodeA, { outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")
      await waitForPeers(nodeC, { inbound: 1 }, undefined, "nodeC")
      nodeA.broadcastBlock(blk, sig, signer.publicKey)
      // Up to 1.5s for C to hear it: a relayed block ends the wait early, a
      // refused one is watched for the whole window.
      const deadline = Date.now() + 1500
      while (nodeC.tip.height < 1 && Date.now() < deadline) await wait(25)

      return { b: nodeB.tip, c: nodeC.tip }
    } finally {
      await closeAll(nodeA, nodeB, nodeC)
    }
  }

  it("accepts a block signed by the elected proposer and relays it", async () => {
    const tips = await relay(proposer, [9601, 9602, 9603])
    expect(tips.b.height).toBe(1)
    expect(tips.c.height).toBe(1)
  }, 10000)

  it("rejects a block signed by another staked validator and does not relay it", async () => {
    const tips = await relay(notProposer, [9611, 9612, 9613])
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 10000)

  it("rejects a block signed by an unstaked key and does not relay it", async () => {
    const tips = await relay(outsider, [9621, 9622, 9623])
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 10000)

  it("keeps the permissive default when no validator set is configured", async () => {
    const portA = 9631
    const portB = 9632
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portA}`], genesis)

    const blk = createBlock(blockHash(genesis), 1, [])
    const sig = signBlock(blk, outsider)

    try {
      // A dials B before B listens, so A's link comes up on a re-dial.
      await waitForPeers(nodeA, { inbound: 1, outbound: 1 }, undefined, "nodeA")
      await waitForPeers(nodeB, { inbound: 1, outbound: 1 }, undefined, "nodeB")
      nodeA.broadcastBlock(blk, sig, outsider.publicKey)
      await waitUntil(() => nodeB.tip.height >= 1, "nodeB to accept the block at height 1")

      expect(nodeB.tip.height).toBe(1)
    } finally {
      await closeAll(nodeA, nodeB)
    }
  }, 10000)
})
