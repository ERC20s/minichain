import { blockHash, createGenesisBlock } from "../src/block"
import { Keypair, keypairFromSeed } from "../src/crypto/ed25519"
import { MAX_SYNC_BLOCKS, Node } from "../src/node"
import { funded } from "./helpers/signed-tx"

/**
 * Catching up PAST one batch (src/node.ts, Node.noticeSyncProgress).
 *
 * Cycles 17 and 18 gave a node the catch-up path: it keeps accepted sealed
 * blocks (src/state/chain.ts), it answers a peer's "req", and it asks for the
 * gap when a peer link opens. But one request is answered with at most
 * MAX_SYNC_BLOCKS (32) blocks — "const count = Math.min(asked, MAX_SYNC_BLOCKS)"
 * — and nothing asked again. The only two triggers were REFUSING a block from
 * above the gap and the onPeerOpen hook, so a node restarted against a chain at
 * height 70 asked once, accepted 1..32, and then sat at 32 for ever: on an idle
 * chain nothing is minted, so no future block ever arrives to refuse, the
 * ledgers stay wrong and chain_height over the RPC reports 32 as the truth.
 *
 * What is pinned here:
 *
 *  - a follower more than two batches behind reaches the full height with NO new
 *    block minted anywhere;
 *  - the follow-up requests are exactly the batch arithmetic — from 1, then 33,
 *    then 65 — which is the off-by-one this change lives or dies on;
 *  - a follow-up is not swallowed by the one-per-second rate limit (the nodes
 *    below run the DEFAULT syncRequestIntervalMs and a batch of 32 blocks
 *    arrives in far less than a second);
 *  - a SHORT batch ends the chain of requests, and an ordinary gossiped block
 *    that moves the tip asks for nothing.
 *
 * The gossip ports used below (9271-9274) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

/** Record every "req" this node broadcasts, without changing what it does. */
function watchRequests(node: Node): Array<{ from?: number; max?: number }> {
  const asked: Array<{ from?: number; max?: number }> = []
  const real = node.gossip.broadcast
  node.gossip.broadcast = (type, payload, opts) => {
    if (type === "req") {
      try {
        asked.push(JSON.parse(new TextDecoder().decode(payload)))
      } catch (e) {
        // a malformed request would fail the assertions below anyway
      }
    }
    real(type, payload, opts)
  }
  return asked
}

/**
 * Mint `count` blocks on `node` with no transactions in them.
 *
 * allowEmpty is exactly the idle chain this bug hides in: the follower has
 * nothing to refuse, so only its own follow-up requests can close the gap.
 */
function mintEmpty(node: Node, proposer: Keypair, count: number): void {
  for (let n = 0; n < count; n++) {
    const blk = node.proposeBlock(proposer.secretKey, proposer.publicKey, { allowEmpty: true })
    expect(blk).not.toBeNull()
  }
}

describe("a node keeps asking until the gap is closed", () => {
  it("catches up over more than two batches with nothing new minted", async () => {
    const genesis = createGenesisBlock()
    const opening = funded([81])
    const proposer = kp(11)

    // No validator set: this is about the gap, not about election.
    const a = new Node(9271, [], genesis, [], opening)
    let b: Node | undefined
    try {
      // 70 heights: two FULL batches (1..32, 33..64) and a short one (65..70).
      mintEmpty(a, proposer, 70)
      expect(a.tip.height).toBe(70)
      expect(a.chain.has(1)).toBe(true)
      expect(a.chain.has(70)).toBe(true)

      // B joins at genesis, 70 blocks behind, and mints nothing at all. Default
      // syncRequestIntervalMs (1000 ms): the follow-up requests below have to
      // get past the rate limiter within a batch's arrival, not around it.
      b = new Node(9272, ["ws://127.0.0.1:9271"], genesis, [], opening)
      const asked = watchRequests(b)
      expect(b.tip.height).toBe(0)

      // Nothing is minted from here on: the only thing that can move B is its
      // own asking.
      for (let i = 0; i < 60 && b.tip.height < 70; i++) await wait(100)

      expect(a.tip.height).toBe(70)
      expect(b.tip.height).toBe(70)
      expect(blockHash(b.tip)).toBe(blockHash(a.tip))
      // and it holds the history, so it can answer the next late joiner
      expect(b.chain.has(1)).toBe(true)
      expect(b.chain.has(70)).toBe(true)

      // The batch arithmetic, exactly: ask from 1, take 1..32 (a full batch, so
      // the last height is 1 + 32 - 1 = 32), ask from 33, take 33..64, ask from
      // 65, take 65..70 — short, so nothing more is asked.
      expect(asked.map((r) => r.from)).toEqual([1, 33, 65])
      expect(asked.every((r) => r.max === MAX_SYNC_BLOCKS)).toBe(true)

      // A quiet moment proves the chain of requests really ended.
      await wait(400)
      expect(asked.length).toBe(3)
    } finally {
      if (b) b.close()
      a.close()
      await wait(20)
    }
  }, 30000)

  it("stops after a short batch, and an ordinary block asks for nothing", async () => {
    const genesis = createGenesisBlock()
    const opening = funded([81])
    const proposer = kp(11)

    const a = new Node(9273, [], genesis, [], opening)
    let b: Node | undefined
    try {
      // Fewer than MAX_SYNC_BLOCKS heights: one request closes the whole gap.
      mintEmpty(a, proposer, 5)
      expect(a.tip.height).toBe(5)

      b = new Node(9274, ["ws://127.0.0.1:9273"], genesis, [], opening)
      const asked = watchRequests(b)

      for (let i = 0; i < 30 && b.tip.height < 5; i++) await wait(100)
      expect(b.tip.height).toBe(5)

      // One request, and no follow-up: a batch shorter than the cap means the
      // peer had nothing more to give.
      await wait(400)
      expect(asked.map((r) => r.from)).toEqual([1])

      // An ordinary gossiped block that moves the tip is not a catch-up batch
      // and must not make this node ask anyone for anything.
      mintEmpty(a, proposer, 1)
      for (let i = 0; i < 20 && b.tip.height < 6; i++) await wait(100)
      expect(b.tip.height).toBe(6)
      expect(blockHash(b.tip)).toBe(blockHash(a.tip))
      expect(asked.length).toBe(1)
    } finally {
      if (b) b.close()
      a.close()
      await wait(20)
    }
  }, 20000)
})
