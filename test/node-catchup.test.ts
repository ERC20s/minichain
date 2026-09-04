import { Block, blockHash, createGenesisBlock } from "../src/block"
import { Keypair, keypairFromSeed } from "../src/crypto/ed25519"
import { MAX_SYNC_BLOCKS, Node, SYNC_REQUEST_INTERVAL_MS } from "../src/node"
import { ChainStore, DEFAULT_CHAIN_STORE_CAPACITY } from "../src/state/chain"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * Catching up (src/state/chain.ts, the "req" frame in src/node.ts and
 * src/gossip/ws.ts).
 *
 * Before this, a Node kept only `this.tip` and acceptBlock refused anything that
 * was not exactly tip.height + 1, so a node that joined after the proposer had
 * minted anything — or that dropped one "blk" frame — silently stopped
 * following the chain for ever: every later block was a future block, it was
 * dropped, and nothing ever asked for the gap. What is pinned here:
 *
 *  - a node that joins at genesis, against a proposer already at height 3,
 *    reaches that proposer's tip with the ledgers moved;
 *  - one request is answered with at most MAX_SYNC_BLOCKS blocks, sealed with
 *    the signature and key they were accepted under, and only to the asker;
 *  - a request for a height this node does not hold is answered with nothing;
 *  - requests are rate limited to one per SYNC_REQUEST_INTERVAL_MS;
 *  - only a block from ABOVE the gap triggers a request: a merely invalid block
 *    at tip + 1 is still just an invalid block;
 *  - the store is bounded, never holds genesis, and never serves a batch with a
 *    hole in it.
 *
 * The gossip ports used below (9251-9258) are used by no other test file.
 */
function wait(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A raw wire envelope, exactly as src/gossip/ws.ts frames one. */
function envelope(type: string, body: any): string {
  const payload = new TextEncoder().encode(JSON.stringify(body))
  return JSON.stringify({ type, payloadHex: hex(payload) })
}

function decodePayload(env: any): any {
  return JSON.parse(Buffer.from(env.payloadHex, "hex").toString("utf8"))
}

/** A block-shaped object that no node can accept: nothing signs it. */
function junkBlock(height: number): Block {
  return {
    parentHash: "not-a-real-parent",
    height,
    timestamp: 1,
    transactions: [],
    merkleRoot: "not-a-real-root",
  }
}

const sender = accountHex(81)

describe("a node catches up over gossip", () => {
  it("lets a node that joined late reach the proposer's tip", async () => {
    const genesis = createGenesisBlock()
    const opening = funded([81])
    const proposer = kp(11)

    // No validator set: this test is about the gap, not about election.
    const a = new Node(9251, [], genesis, [], opening)
    let b: Node | undefined
    try {
      for (let n = 1; n <= 3; n++) {
        expect(
          a.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: n })).admitted
        ).toBe(true)
        expect(a.proposeBlock(proposer.secretKey, proposer.publicKey)).not.toBeNull()
      }
      expect(a.tip.height).toBe(3)

      // every accepted block is held, sealed; genesis is not held at all
      expect(a.chain.size).toBe(3)
      expect(a.chain.get(0)).toBeUndefined()
      expect(a.chain.has(1)).toBe(true)
      expect(a.chain.get(3)!.sig.length).toBeGreaterThan(0)
      expect(a.chain.get(3)!.pubKey).toEqual(proposer.publicKey)

      // B joins now, at genesis, three blocks behind. Same genesis, same opening
      // balances — createGenesisBlock is deterministic.
      b = new Node(9252, ["ws://127.0.0.1:9251"], genesis, [], opening)
      await wait(250)
      expect(b.tip.height).toBe(0)

      // A mints a fourth block. B cannot use it (height 4, tip 0), asks for the
      // gap from height 1, and A answers 1, 2, 3 and 4 to B alone.
      expect(
        a.submitTransaction(signedTx(81, { recipient: "carol", amount: 1, nonce: 4 })).admitted
      ).toBe(true)
      expect(a.proposeBlock(proposer.secretKey, proposer.publicKey)).not.toBeNull()
      await wait(700)

      expect(b.tip.height).toBe(4)
      expect(blockHash(b.tip)).toBe(blockHash(a.tip))
      // the ledgers moved with the blocks, through the ordinary accept path
      expect(b.nonces.lastNonce(sender)).toBe(4)
      expect(b.balances.balanceOf(sender)).toBe(a.balances.balanceOf(sender))
      // and B now holds the same history, so it can answer the next late joiner
      expect(b.chain.has(1)).toBe(true)
      expect(b.chain.has(4)).toBe(true)
    } finally {
      if (b) b.close()
      a.close()
      await wait(20)
    }
  }, 20000)

  it("answers one request with at most MAX_SYNC_BLOCKS blocks, and only the asker", async () => {
    const genesis = createGenesisBlock()
    const node = new Node(9253, [], genesis, [], funded([81]))
    let ws: any
    try {
      // 40 sealed heights, put straight into the store: this test is about what
      // the "req" handler serves, not about how the blocks got there.
      for (let h = 1; h <= 40; h++) {
        expect(node.chain.put(junkBlock(h), new Uint8Array(64), new Uint8Array(32))).toBe(true)
      }

      // Anything this node broadcasts to the whole mesh would show up here.
      const broadcast: string[] = []
      const real = node.gossip.broadcast
      node.gossip.broadcast = (type, payload, opts) => {
        broadcast.push(type)
        real(type, payload, opts)
      }

      ws = new (require("ws"))("ws://127.0.0.1:9253")
      await new Promise((res) => ws.on("open", res))
      const seen: any[] = []
      ws.on("message", (data: any) => {
        try {
          seen.push(JSON.parse(data.toString()))
        } catch (e) {}
      })

      // ask for more than the cap allows
      ws.send(envelope("req", { from: 1, max: 100 }))
      await wait(400)

      expect(seen.length).toBe(MAX_SYNC_BLOCKS)
      const heights = seen.map((env) => decodePayload(env).height)
      expect(heights[0]).toBe(1)
      expect(heights[heights.length - 1]).toBe(MAX_SYNC_BLOCKS)
      // every answer is an ordinary sealed "blk" frame
      expect(seen.every((env) => env.type === "blk")).toBe(true)
      expect(seen.every((env) => typeof env.sigHex === "string" && env.sigHex.length > 0)).toBe(true)
      expect(seen.every((env) => typeof env.pubKeyHex === "string")).toBe(true)
      // the answer went to the asker: nothing was flooded at the mesh
      expect(broadcast.length).toBe(0)

      // a smaller window is honoured
      seen.length = 0
      ws.send(envelope("req", { from: 5, max: 2 }))
      await wait(300)
      expect(seen.map((env) => decodePayload(env).height)).toEqual([5, 6])

      // a height this node does not hold is answered with nothing at all
      seen.length = 0
      ws.send(envelope("req", { from: 500, max: 8 }))
      await wait(300)
      expect(seen.length).toBe(0)

      // and so is a malformed request
      ws.send(envelope("req", { from: "one" }))
      ws.send(envelope("req", { from: -3 }))
      await wait(300)
      expect(seen.length).toBe(0)
    } finally {
      if (ws) try { ws.close() } catch (e) {}
      node.close()
      await wait(20)
    }
  }, 15000)

  it("asks for the gap at most once per interval", async () => {
    const genesis = createGenesisBlock()
    let clock = 1000000
    const node = new Node(9255, [], genesis, [], funded([81]), { now: () => clock })
    try {
      const sent: Uint8Array[] = []
      const real = node.gossip.broadcast
      node.gossip.broadcast = (type, payload, opts) => {
        if (type === "req") sent.push(payload)
        real(type, payload, opts)
      }

      expect(node.requestSync()).toBe(true)
      expect(node.requestSync()).toBe(false)
      expect(node.requestSync()).toBe(false)

      clock += SYNC_REQUEST_INTERVAL_MS
      expect(node.requestSync()).toBe(true)

      expect(sent.length).toBe(2)
      expect(JSON.parse(new TextDecoder().decode(sent[0]))).toEqual({
        from: 1,
        max: MAX_SYNC_BLOCKS,
      })
    } finally {
      node.close()
      await wait(20)
    }
  }, 8000)

  it("asks only when the refused block is from above the gap", async () => {
    const genesis = createGenesisBlock()
    const node = new Node(9257, [], genesis, [], funded([81]))
    let ws: any
    try {
      const asked: any[] = []
      const real = node.gossip.broadcast
      node.gossip.broadcast = (type, payload, opts) => {
        if (type === "req") asked.push(JSON.parse(new TextDecoder().decode(payload)))
        real(type, payload, opts)
      }

      ws = new (require("ws"))("ws://127.0.0.1:9257")
      await new Promise((res) => ws.on("open", res))

      // height 1 is exactly tip + 1: refused because it is junk, not because
      // this node is behind. Nothing is asked for.
      ws.send(envelope("blk", junkBlock(1)))
      await wait(300)
      expect(asked.length).toBe(0)
      expect(node.tip.height).toBe(0)

      // height 7 is above the gap: this node cannot use it and now says so.
      ws.send(envelope("blk", junkBlock(7)))
      await wait(300)
      expect(asked.length).toBe(1)
      expect(asked[0]).toEqual({ from: 1, max: MAX_SYNC_BLOCKS })
      // and nothing about the tip or the ledgers moved on an unaccepted block
      expect(node.tip.height).toBe(0)
    } finally {
      if (ws) try { ws.close() } catch (e) {}
      node.close()
      await wait(20)
    }
  }, 10000)
})

describe("ChainStore", () => {
  const sealed = (height: number): [Block, Uint8Array, Uint8Array] => [
    junkBlock(height),
    new Uint8Array(64),
    new Uint8Array(32),
  ]

  it("holds at most its capacity, evicting the lowest height", () => {
    const store = new ChainStore(3)
    for (let h = 1; h <= 5; h++) {
      const [blk, sig, pubKey] = sealed(h)
      store.put(blk, sig, pubKey)
    }
    expect(store.size).toBe(3)
    expect(store.lowestHeight).toBe(3)
    expect(store.highestHeight).toBe(5)
    expect(store.has(2)).toBe(false)
    expect(store.has(5)).toBe(true)
    expect(DEFAULT_CHAIN_STORE_CAPACITY).toBe(1024)
    expect(new ChainStore().capacity).toBe(DEFAULT_CHAIN_STORE_CAPACITY)
    expect(new ChainStore(0).capacity).toBe(DEFAULT_CHAIN_STORE_CAPACITY)
  })

  it("never returns a batch with a hole in it", () => {
    const store = new ChainStore()
    for (const h of [1, 2, 4, 5]) {
      const [blk, sig, pubKey] = sealed(h)
      store.put(blk, sig, pubKey)
    }
    expect(store.range(1, 10).map((s) => s.block.height)).toEqual([1, 2])
    expect(store.range(4, 10).map((s) => s.block.height)).toEqual([4, 5])
    // a height it does not hold answers nothing
    expect(store.range(3, 10)).toEqual([])
    // and a nonsensical window answers nothing rather than walking
    expect(store.range(1, 0)).toEqual([])
    expect(store.range(-1, 5)).toEqual([])
  })

  it("refuses an entry it could never serve", () => {
    const store = new ChainStore()
    const [blk, sig, pubKey] = sealed(1)
    // no seal: a peer's acceptBlock refuses a block with no sig or pubKey
    expect(store.put(blk, undefined, pubKey)).toBe(false)
    expect(store.put(blk, sig, undefined)).toBe(false)
    expect(store.put(blk, new Uint8Array(0), pubKey)).toBe(false)
    // an unusable height cannot be keyed
    expect(store.put({ ...blk, height: -1 }, sig, pubKey)).toBe(false)
    expect(store.put({ ...blk, height: 1.5 }, sig, pubKey)).toBe(false)
    expect(store.size).toBe(0)
    // the well-formed entry lands
    expect(store.put(blk, sig, pubKey)).toBe(true)
    expect(store.size).toBe(1)
  })
})
