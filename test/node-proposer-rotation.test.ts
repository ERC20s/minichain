import { Block, blockHash, createBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, keypairFromSeed, sign } from "../src/crypto/ed25519"
import { MAX_FUTURE_DRIFT_MS, Node, PROPOSER_SLOT_MS } from "../src/node"
import {
  PROPOSER_ROUND_SEPARATOR,
  PROPOSER_SEED_PREFIX,
  Validator,
  proposerSeed,
  publicKeyToHex,
  selectValidator,
} from "../src/validators"
import { funded, signedTx } from "./helpers/signed-tx"

/**
 * Proposer rotation by time slot (src/validators.ts proposerSeed(parent, round),
 * src/node.ts PROPOSER_SLOT_MS and Node.proposerRound).
 *
 * The hole this closes: the proposer seed was a pure function of the tip
 * ("pos:" || blockHash(tip)). If the validator elected for that tip was
 * offline, crashed or partitioned, nobody else could ever propose — the tip
 * never moved, so the seed never changed, so the same absent validator was
 * elected for ever and the chain halted in silence, with no error.
 *
 * What is pinned here:
 *
 *  - round 0 is BYTE-FOR-BYTE the seed this chain always used, so every
 *    existing block, test vector and election is unchanged;
 *  - the round is derived arithmetic over the header this chain already has:
 *    max(0, floor((stamp - tip.timestamp) / PROPOSER_SLOT_MS));
 *  - a validator that loses round 0 mints NOTHING while the clock is inside
 *    slot 0, and mints once the clock reaches a slot it wins — this is the
 *    liveness fix;
 *  - the round-0 winner still mints inside slot 0, exactly as before;
 *  - a block signed by the winner of a round its own timestamp does not sit in
 *    is refused, in both directions.
 *
 * Every clock here is injected (NodeOptions.now), so nothing waits for real
 * time. The gossip ports used below (9281-9284) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

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

function seedText(parent: Block, round?: number): string {
  return new TextDecoder().decode(
    round === undefined ? proposerSeed(parent) : proposerSeed(parent, round)
  )
}

describe("Proposer rotation by time slot", () => {
  const alice = kp(11)
  const bob = kp(22)

  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 60 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 40 },
  ]

  // A FIXED genesis stamp: every clock below is expressed against it, so the
  // rounds these tests talk about are exact rather than "whenever jest ran".
  const T0 = 1700000000000
  const genesis = createBlock("0x00", 0, [], T0)

  const keyFor = (hex: string | null): Keypair =>
    hex === publicKeyToHex(alice.publicKey) ? alice : bob

  const winnerOf = (round: number): string | null =>
    selectValidator(validators, proposerSeed(genesis, round))

  // Round 0's winner is who this chain has always elected for height 1.
  const roundZeroWinner = winnerOf(0)
  const first = keyFor(roundZeroWinner)

  // The first round that elects somebody ELSE. With two validators that is the
  // other one; the loop is here so the fixture never depends on a hash guess.
  let rotateRound = 0
  for (let r = 1; r <= 20; r++) {
    if (winnerOf(r) !== roundZeroWinner) {
      rotateRound = r
      break
    }
  }
  const second = keyFor(winnerOf(rotateRound))

  // Account 85 pays for the transfers below; it appears in no other test file.
  const opening = funded([85])
  const transfer = () => signedTx(85, { recipient: "carol", amount: 1, nonce: 1 })

  it("rotates to a different validator within the drift window", () => {
    expect(PROPOSER_SLOT_MS).toBe(6000)
    expect(roundZeroWinner).not.toBeNull()
    expect(rotateRound).toBeGreaterThan(0)
    expect(publicKeyToHex(second.publicKey)).not.toBe(publicKeyToHex(first.publicKey))
    // A slot a node can actually reach: MAX_FUTURE_DRIFT_MS bounds how far
    // ahead a block may be stamped, so the rotation must land inside it.
    expect(rotateRound * PROPOSER_SLOT_MS).toBeLessThanOrEqual(MAX_FUTURE_DRIFT_MS)
  })

  it("keeps round 0 byte-for-byte the seed the chain always used", () => {
    expect(proposerSeed(genesis, 0)).toEqual(proposerSeed(genesis))
    expect(seedText(genesis, 0)).toBe(PROPOSER_SEED_PREFIX + blockHash(genesis))
    expect(selectValidator(validators, proposerSeed(genesis, 0))).toBe(roundZeroWinner)

    // A later round is a DIFFERENT byte string, and says so in the open.
    expect(seedText(genesis, 3)).toBe(
      PROPOSER_SEED_PREFIX + blockHash(genesis) + PROPOSER_ROUND_SEPARATOR + "3"
    )
    expect(proposerSeed(genesis, 1)).not.toEqual(proposerSeed(genesis, 0))

    // Anything that is not a positive safe integer is round 0, never a throw.
    expect(proposerSeed(genesis, -1)).toEqual(proposerSeed(genesis, 0))
    expect(proposerSeed(genesis, 1.5)).toEqual(proposerSeed(genesis, 0))
    expect(proposerSeed(genesis, Number.NaN)).toEqual(proposerSeed(genesis, 0))
    // ...and the parent may still be a hash already computed.
    expect(proposerSeed(blockHash(genesis), 2)).toEqual(proposerSeed(genesis, 2))
  })

  it("derives the round from the block's own stamp against the tip", async () => {
    const node = new Node(9281, [], genesis, validators, opening, { now: () => T0 })
    try {
      expect(node.proposerRound(T0)).toBe(0)
      expect(node.proposerRound(T0 + PROPOSER_SLOT_MS - 1)).toBe(0)
      expect(node.proposerRound(T0 + PROPOSER_SLOT_MS)).toBe(1)
      expect(node.proposerRound(T0 + 2 * PROPOSER_SLOT_MS + 5)).toBe(2)
      // Behind the parent, or not a usable number at all: round 0.
      expect(node.proposerRound(T0 - 60000)).toBe(0)
      expect(node.proposerRound(Number.NaN)).toBe(0)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("lets a validator that lost round 0 mint once the clock reaches its slot", async () => {
    let clock = T0
    const node = new Node(9282, [], genesis, validators, opening, { now: () => clock })
    try {
      expect(node.submitTransaction(transfer()).admitted).toBe(true)

      // Inside slot 0 the other validator is elected, so this one mints nothing
      // — exactly the behaviour that used to last for ever.
      expect(node.proposeBlock(second.secretKey, second.publicKey)).toBeNull()
      clock = T0 + PROPOSER_SLOT_MS - 1
      expect(node.proposeBlock(second.secretKey, second.publicKey)).toBeNull()
      expect(node.tip.height).toBe(0)

      // The elected proposer is absent, so the clock walks on to a slot this
      // validator wins.
      clock = T0 + rotateRound * PROPOSER_SLOT_MS
      expect(node.proposerRound(clock)).toBe(rotateRound)

      const blk = node.proposeBlock(second.secretKey, second.publicKey)
      expect(blk).not.toBeNull()
      expect(blk!.height).toBe(1)
      expect(blk!.timestamp).toBe(clock)
      expect(node.tip.height).toBe(1)
      expect(blockHash(node.tip)).toBe(blockHash(blk!))
      // ...and the round-0 winner is no longer entitled to that same height.
      expect(node.mempool.size).toBe(0)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("still lets the round-0 winner mint inside slot 0", async () => {
    // Ten milliseconds after genesis: an ordinary, healthy chain, where every
    // block is minted well inside its parent's slot.
    const clock = T0 + 10
    const node = new Node(9283, [], genesis, validators, opening, { now: () => clock })
    try {
      expect(node.submitTransaction(transfer()).admitted).toBe(true)
      expect(node.proposerRound(clock)).toBe(0)

      const blk = node.proposeBlock(first.secretKey, first.publicKey)
      expect(blk).not.toBeNull()
      expect(blk!.timestamp).toBe(clock)
      // The tip has moved, so the round is measured from the minted block now:
      // a fresh tip puts this clock back in slot 0.
      expect(node.proposerRound(clock)).toBe(0)
      expect(node.tip.height).toBe(1)
      expect(blockHash(node.tip)).toBe(blockHash(blk!))
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("refuses a block signed by the winner of a round its stamp is not in", async () => {
    const stampR = T0 + rotateRound * PROPOSER_SLOT_MS
    const clock = stampR
    const node = new Node(9284, [], genesis, validators, opening, { now: () => clock })
    try {
      const tx = transfer()
      const parent = blockHash(genesis)

      // Round rotateRound's winner, stamped inside slot 0: the round-0 winner
      // is elected there, so this is refused.
      const early = createBlock(parent, 1, [tx], T0)
      expect(node.acceptBlock(early, signBlock(early, second), second.publicKey)).toBe(false)

      // ...and the converse: round 0's winner cannot reach forward into a slot
      // that elects somebody else.
      const late = createBlock(parent, 1, [tx], stampR)
      expect(node.acceptBlock(late, signBlock(late, first), first.publicKey)).toBe(false)

      expect(node.tip.height).toBe(0)
      // Nothing was spent by the two refusals: staging never touched a ledger.
      expect(node.nonces.lastNonce(tx.sender)).toBeUndefined()

      // The same block, signed by the validator that round actually elects.
      expect(node.acceptBlock(late, signBlock(late, second), second.publicKey)).toBe(true)
      expect(node.tip.height).toBe(1)
      expect(node.tip.timestamp).toBe(stampR)
      expect(node.nonces.lastNonce(tx.sender)).toBe(1)
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)
})
