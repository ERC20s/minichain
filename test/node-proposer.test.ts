import { Node } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { createBlock, Block } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { selectValidator, publicKeyToHex, Validator } from "../src/validators"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

function kpFrom(n: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = n
  return keypairFromSeed(seed)
}

function signedFor(blk: Block, kp: Keypair): Uint8Array {
  const msg = canonicalBlockEncoding({
    parentHash: blk.parentHash,
    height: blk.height,
    timestamp: blk.timestamp,
    merkleRoot: blk.merkleRoot,
    proposerPublicKey: kp.publicKey,
  })
  return sign(msg, kp.secretKey)
}

describe("stake-weighted proposer eligibility", () => {
  const kpA = kpFrom(11)
  const kpB = kpFrom(12)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(kpA.publicKey), stake: 40 },
    { publicKey: publicKeyToHex(kpB.publicKey), stake: 60 },
  ]

  const genesis = createBlock("0x00", 0, [])
  const blk = createBlock(genesis.merkleRoot, 1, [{ sender: "alice", recipient: "bob", amount: 1, nonce: 1 }])

  // the seed a node derives for this block: utf8(parentHash + ":" + height)
  const seed = new TextEncoder().encode(`${blk.parentHash}:${blk.height}`)
  const expected = selectValidator(validators, seed)
  const eligible = publicKeyToHex(kpA.publicKey) === expected ? kpA : kpB
  const ineligible = eligible === kpA ? kpB : kpA

  it("accepts a block signed by the selected proposer", async () => {
    const portA = 9311
    const portB = 9312

    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, validators)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portA}`], genesis, validators)

    expect(expected).not.toBeNull()
    expect(nodeB.expectedProposer()).toBe(expected)

    await wait(50)
    nodeA.broadcastBlock(blk, signedFor(blk, eligible), eligible.publicKey)
    await wait(200)

    nodeA.close()
    nodeB.close()

    expect(nodeB.tip.height).toBe(1)
    expect(nodeB.tip.merkleRoot).toBe(blk.merkleRoot)
  }, 4000)

  it("rejects the same block signed by an ineligible validator", async () => {
    const portA = 9313
    const portB = 9314

    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, validators)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portA}`], genesis, validators)

    await wait(50)
    nodeA.broadcastBlock(blk, signedFor(blk, ineligible), ineligible.publicKey)
    await wait(200)

    nodeA.close()
    nodeB.close()

    // signature is valid, but the signer is not this height's proposer
    expect(nodeB.tip.height).toBe(0)
    expect(nodeB.tip.merkleRoot).toBe(genesis.merkleRoot)
  }, 4000)

  it("keeps open-membership behaviour when no validator set is configured", async () => {
    const portA = 9315
    const portB = 9316

    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis)
    const nodeB = new Node(portB, [`ws://127.0.0.1:${portA}`], genesis)

    await wait(50)
    nodeA.broadcastBlock(blk, signedFor(blk, ineligible), ineligible.publicKey)
    await wait(200)

    nodeA.close()
    nodeB.close()

    expect(nodeB.tip.height).toBe(1)
    expect(nodeB.expectedProposer()).toBeNull()
  }, 4000)
})
