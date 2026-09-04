import { MAX_FUTURE_DRIFT_MS, Node, NodeOptions } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { blockHash, createBlock, Block } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { funded, signedTx } from "./helpers/signed-tx"

/**
 * Block timestamp bounds (src/node.ts).
 *
 * Every other header field was checked when a block arrived; the timestamp was
 * only copied into the header the signature is verified over, so a proposer
 * could stamp a block with any integer. These tests pin the three bounds:
 *  - a stamp that goes BACKWARDS from the tip is dropped,
 *  - a stamp further ahead than maxFutureDriftMs is dropped,
 *  - equal-to-parent and slightly-ahead stamps are accepted, and the drift is
 *    configurable per node.
 */
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

describe("Node bounds block timestamps", () => {
  const proposer = kp(44)
  const genesis = createBlock("0x00", 0, [])
  // The middle node's clock is pinned here so the tests do not depend on how
  // long the gossip round trip takes.
  const BASE = genesis.timestamp

  it("exports a two-minute default drift", () => {
    expect(MAX_FUTURE_DRIFT_MS).toBe(120000)
  })

  /**
   * A -> B -> C. B is the node under test (pinned clock, optional drift); C
   * hears the block only if B accepted and re-broadcast it, so C's tip is the
   * witness for "not propagated".
   */
  async function relay(
    timestamp: number,
    ports: [number, number, number],
    options?: NodeOptions,
    signAt?: number
  ) {
    const [portA, portB, portC] = ports
    // Sender 13 must be able to afford the transfer on every node on the path,
    // or the block would be dropped for insolvency and hide what is tested here.
    const opening = funded([13])
    const nodeC = new Node(portC, [], genesis, [], opening)
    await wait(60)
    const nodeB = new Node(
      portB,
      [`ws://127.0.0.1:${portC}`],
      genesis,
      [],
      opening,
      { now: () => BASE, ...(options || {}) }
    )
    await wait(60)
    const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)

    const blk = createBlock(blockHash(genesis), 1, [
      signedTx(13, { recipient: "bob", amount: 1, nonce: 1 }),
    ])
    // The stamp under test. merkleRoot does not depend on it, and the header
    // signature is made over the stamp the block carries, so the block is
    // well-formed either way. signAt exists for the one case the canonical
    // header encoder itself refuses to sign (a fractional stamp): the header is
    // signed at a legal time and the illegal stamp is written afterwards, which
    // is exactly what a hostile peer can do on the wire.
    blk.timestamp = typeof signAt === "number" ? signAt : timestamp
    const sig = signBlock(blk, proposer)
    blk.timestamp = timestamp

    await wait(120)
    nodeA.broadcastBlock(blk, sig, proposer.publicKey)
    await wait(250)

    const tips = { b: nodeB.tip, c: nodeC.tip }
    nodeA.close(); nodeB.close(); nodeC.close()
    await wait(20)
    return tips
  }

  it("accepts a block stamped exactly at its parent's time", async () => {
    const tips = await relay(BASE, [9011, 9012, 9013])
    expect(tips.b.height).toBe(1)
    expect(tips.c.height).toBe(1)
  }, 5000)

  it("accepts a block stamped slightly ahead of the node's clock", async () => {
    const tips = await relay(BASE + 30000, [9021, 9022, 9023])
    expect(tips.b.height).toBe(1)
    expect(tips.c.height).toBe(1)
  }, 5000)

  it("drops a block stamped before its parent and does not relay it", async () => {
    const tips = await relay(BASE - 1000, [9031, 9032, 9033])
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 5000)

  it("drops a far-future block and does not relay it", async () => {
    const tips = await relay(BASE + 10 * 60 * 1000, [9041, 9042, 9043])
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 5000)

  it("honours a tighter configured drift", async () => {
    // 5 seconds ahead: inside the 120s default, outside this node's 1s bound.
    const tips = await relay(BASE + 5000, [9051, 9052, 9053], { maxFutureDriftMs: 1000 })
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 5000)

  it("drops a block whose timestamp is not a usable integer", async () => {
    const tips = await relay(BASE + 0.5, [9061, 9062, 9063], undefined, BASE)
    expect(tips.b.height).toBe(0)
    expect(tips.c.height).toBe(0)
  }, 5000)

  it("keeps the default drift when the option is missing or unusable", () => {
    const node = new Node(9071, [], genesis, [], undefined, { maxFutureDriftMs: -1 })
    expect(node.maxFutureDriftMs).toBe(MAX_FUTURE_DRIFT_MS)
    node.close()
    const other = new Node(9072, [], genesis)
    expect(other.maxFutureDriftMs).toBe(MAX_FUTURE_DRIFT_MS)
    expect(typeof other.now()).toBe("number")
    other.close()
  })
})
