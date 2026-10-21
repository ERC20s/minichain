import { Block, blockHash, createBlock, createGenesisBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import * as ed25519 from "../src/crypto/ed25519"
import * as merkle from "../src/merkle"
import * as txModule from "../src/tx"
import { Keypair, keypairFromSeed, sign } from "../src/crypto/ed25519"
import { Node } from "../src/node"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { closeAll } from "./helpers/gossip"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"
import { SignedTransaction } from "../src/types/transaction"

/**
 * The ORDER of Node.acceptBlock's checks (src/node.ts; SPEC.md "Block
 * acceptance order"):
 *
 *   linkage -> timestamp -> header seal -> eligibility -> Merkle commitment
 *   -> transaction signatures -> nonces (replay) -> balances -> state
 *
 * Pinned with spies on the functions each stage calls, so a block that fails
 * an early stage is shown never to reach a later one: an unelected key cannot
 * make this node verify a block's worth of transaction signatures, a bad
 * transaction signature never reaches the ledgers, and nothing is written
 * unless every stage passed. The gossip port (9751) is used by no other test.
 */
function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

function signBlock(blk: Block, keypair: Keypair): Uint8Array {
  return sign(
    canonicalBlockEncoding({
      parentHash: blk.parentHash,
      height: blk.height,
      timestamp: blk.timestamp,
      merkleRoot: blk.merkleRoot,
      proposerPublicKey: keypair.publicKey,
    }),
    keypair.secretKey
  )
}

describe("acceptBlock checks in order and stops at the first failure", () => {
  const alice = kp(11)
  const bob = kp(22)
  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]
  const genesis = createGenesisBlock()
  const electedHex = selectValidator(validators, proposerSeed(genesis, 0))
  const elected = electedHex === publicKeyToHex(alice.publicKey) ? alice : bob
  const other = elected === alice ? bob : alice
  const NOW = 1_700_000_000_000

  let node: Node
  const spies = {
    headerVerify: null as unknown as jest.SpyInstance,
    merkleRoot: null as unknown as jest.SpyInstance,
    verifyTransaction: null as unknown as jest.SpyInstance,
    nonceStage: null as unknown as jest.SpyInstance,
    balanceStage: null as unknown as jest.SpyInstance,
  }

  beforeAll(() => {
    node = new Node(9751, [], genesis, validators, funded([12]), { now: () => NOW })
  })
  afterAll(async () => {
    await closeAll(node)
  })
  beforeEach(() => {
    spies.headerVerify = jest.spyOn(ed25519, "verify")
    spies.merkleRoot = jest.spyOn(merkle, "merkleRoot")
    spies.verifyTransaction = jest.spyOn(txModule, "verifyTransaction")
    spies.nonceStage = jest.spyOn(node.nonces, "stage")
    spies.balanceStage = jest.spyOn(node.balances, "stage")
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // Every test block is stamped like genesis (0): never behind its parent,
  // inside the node's drift, and in round 0 — the round `elected` is for. The
  // test's own block building calls merkleRoot and the leaf encoder, so the
  // spies are cleared once the block exists and before acceptBlock runs.
  const STAMP = genesis.timestamp
  function block(txs: SignedTransaction[], timestamp = STAMP): Block {
    const blk = createBlock(blockHash(node.tip), node.tip.height + 1, txs, timestamp)
    jest.clearAllMocks()
    return blk
  }
  const transfer = (nonce: number, amount = 1) => signedTx(12, { recipient: "carol", amount, nonce })

  it("stage 1, linkage: a wrong height costs nothing else", () => {
    const blk = createBlock(blockHash(genesis), 2, [transfer(1)], STAMP)
    jest.clearAllMocks()
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.headerVerify).not.toHaveBeenCalled()
    expect(spies.merkleRoot).not.toHaveBeenCalled()
    expect(spies.verifyTransaction).not.toHaveBeenCalled()
  })

  it("stage 2, timestamp: a stamp past the drift costs nothing else", () => {
    const blk = block([transfer(1)], NOW + node.maxFutureDriftMs + 1)
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.headerVerify).not.toHaveBeenCalled()
    expect(spies.merkleRoot).not.toHaveBeenCalled()
  })

  it("stage 3, seal: a wrong-sized key or signature is refused before any crypto", () => {
    const blk = block([transfer(1)])
    const sig = signBlock(blk, elected)
    expect(node.acceptBlock(blk, sig.slice(0, 63), elected.publicKey)).toBe(false)
    expect(node.acceptBlock(blk, sig, elected.publicKey.slice(0, 31))).toBe(false)
    expect(node.acceptBlock(blk, undefined, elected.publicKey)).toBe(false)
    expect(spies.headerVerify).not.toHaveBeenCalled()
    expect(spies.merkleRoot).not.toHaveBeenCalled()
    expect(spies.verifyTransaction).not.toHaveBeenCalled()
  })

  it("stage 3, seal: a bad header signature costs one verification and no transaction work", () => {
    const blk = block([transfer(1)])
    const forged = signBlock({ ...blk, timestamp: blk.timestamp + 1 }, elected)
    expect(node.acceptBlock(blk, forged, elected.publicKey)).toBe(false)
    expect(spies.headerVerify).toHaveBeenCalledTimes(1)
    expect(spies.merkleRoot).not.toHaveBeenCalled()
    expect(spies.verifyTransaction).not.toHaveBeenCalled()
    expect(spies.nonceStage).not.toHaveBeenCalled()
  })

  it("stage 4, eligibility: an unelected validator's block never reaches the transactions", () => {
    const blk = block([transfer(1), transfer(2), transfer(3)])
    expect(node.acceptBlock(blk, signBlock(blk, other), other.publicKey)).toBe(false)
    expect(spies.headerVerify).toHaveBeenCalledTimes(1)
    expect(spies.merkleRoot).not.toHaveBeenCalled()
    expect(spies.verifyTransaction).not.toHaveBeenCalled()
    expect(spies.nonceStage).not.toHaveBeenCalled()
    expect(spies.balanceStage).not.toHaveBeenCalled()
  })

  it("stage 5, commitment: a wrong Merkle root stops before the signatures", () => {
    const honest = block([transfer(1)])
    const blk = { ...honest, merkleRoot: createBlock(honest.parentHash, 1, [transfer(9)], STAMP).merkleRoot }
    jest.clearAllMocks()
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.headerVerify).toHaveBeenCalledTimes(1)
    expect(spies.merkleRoot).toHaveBeenCalledTimes(1)
    expect(spies.verifyTransaction).not.toHaveBeenCalled()
    expect(spies.nonceStage).not.toHaveBeenCalled()
  })

  it("stage 6, authorisation: a bad transaction signature never reaches the ledgers", () => {
    const bad: SignedTransaction = { ...transfer(1), amount: 2 } // signed for amount 1
    const blk = block([bad])
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.merkleRoot).toHaveBeenCalledTimes(1)
    expect(spies.verifyTransaction).toHaveBeenCalledTimes(1)
    expect(spies.nonceStage).not.toHaveBeenCalled()
    expect(spies.balanceStage).not.toHaveBeenCalled()
  })

  it("stage 7, freshness: a replayed nonce stops before the balances", () => {
    const blk = block([transfer(1), transfer(1)])
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.verifyTransaction).toHaveBeenCalledTimes(2)
    expect(spies.nonceStage).toHaveBeenCalledTimes(1)
    expect(spies.balanceStage).not.toHaveBeenCalled()
  })

  it("stage 8, solvency: an overdraft is the last refusal and writes nothing", () => {
    const blk = block([transfer(1, 1_000_001)])
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(spies.nonceStage).toHaveBeenCalledTimes(1)
    expect(spies.balanceStage).toHaveBeenCalledTimes(1)
    // nothing was written by any of the refusals above
    expect(node.tip.height).toBe(0)
    expect(node.nonces.lastNonce(accountHex(12))).toBeUndefined()
    expect(node.balances.balanceOf(accountHex(12))).toBe(1_000_000)
    expect(node.chain.size).toBe(0)
  })

  it("stage 9, state: a block that passes every stage moves tip, nonces, balances and store together", () => {
    const blk = block([transfer(1, 5), transfer(2, 7)])
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(true)
    // one ed25519 verification for the header seal, one per transaction
    expect(spies.headerVerify).toHaveBeenCalledTimes(3)
    expect(spies.merkleRoot).toHaveBeenCalledTimes(1)
    expect(spies.verifyTransaction).toHaveBeenCalledTimes(2)
    expect(spies.nonceStage).toHaveBeenCalledTimes(1)
    expect(spies.balanceStage).toHaveBeenCalledTimes(1)
    expect(node.tip.height).toBe(1)
    expect(blockHash(node.tip)).toBe(blockHash(blk))
    expect(node.nonces.lastNonce(accountHex(12))).toBe(2)
    expect(node.balances.balanceOf(accountHex(12))).toBe(1_000_000 - 12)
    expect(node.balances.balanceOf("carol")).toBe(12)
    expect(node.chain.get(1)!.pubKey).toEqual(elected.publicKey)
  })

  it("the same transaction cannot be replayed into the next block", () => {
    const blk = block([transfer(2, 7)]) // nonce 2 already landed at height 1
    expect(node.acceptBlock(blk, signBlock(blk, elected), elected.publicKey)).toBe(false)
    expect(node.tip.height).toBe(1)
    const fresh = block([transfer(3, 7)])
    const electedNow = selectValidator(validators, proposerSeed(node.tip, 0))
    const proposer = electedNow === publicKeyToHex(alice.publicKey) ? alice : bob
    expect(node.acceptBlock(fresh, signBlock(fresh, proposer), proposer.publicKey)).toBe(true)
    expect(node.tip.height).toBe(2)
  })
})
