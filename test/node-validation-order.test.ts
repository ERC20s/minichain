/**
 * Validation ORDER in the gossip "blk" handler (src/node.ts).
 *
 * The gossip transport authenticates nobody: src/gossip/ws.ts accepts any
 * inbound socket and any well-formed frame up to the 64 KiB payload cap, and a
 * node's tip hash is public. So any peer can hand a node a block with correct
 * linkage, a legal timestamp and a correctly computed Merkle root over a pile of
 * junk-signed transactions. Until this change the handler did the block-sized
 * work first — the Merkle recompute and ONE ed25519 verification PER
 * TRANSACTION, plus nonce and balance staging — and only afterwards asked
 * whether the block carried a valid proposer signature at all. One cheap frame
 * bought N expensive verifications, as fast as the socket allowed.
 *
 * These tests pin the new order by COUNTING calls to verifyTransaction: a block
 * with a missing, forged or unelected header signature must cost ZERO
 * per-transaction verifications, while a genuinely valid block must still be
 * verified transaction by transaction and must still move the tip.
 *
 * src/tx is mocked with its REAL implementation, verifyTransaction wrapped in a
 * jest.fn (ts-jest compiles to CommonJS, so src/node.ts reads the property off
 * the module object at call time and sees the wrapper). Nothing else is
 * replaced, so signing and verification behave exactly as in production.
 *
 * The block is delivered by a bare WebSocket — the hostile peer of the threat
 * model — rather than by a second Node, so every counted call belongs to the
 * node under test and a re-broadcast cannot inflate the count.
 */
jest.mock("../src/tx", () => {
  const actual = jest.requireActual("../src/tx") as typeof import("../src/tx")
  return {
    __esModule: true,
    ...actual,
    verifyTransaction: jest.fn(actual.verifyTransaction),
  }
})

import WebSocket from "ws"
import { Node } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { blockHash, createBlock, Block } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import * as txModule from "../src/tx"
import { funded, signedTx } from "./helpers/signed-tx"

const verifyTransactionMock = (txModule.verifyTransaction as unknown) as jest.Mock

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
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

/** One frame from an unauthenticated peer, exactly as the transport accepts it. */
async function sendFrame(port: number, envelope: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve())
    ws.on("error", (e: Error) => reject(e))
  })
  ws.send(JSON.stringify(envelope))
  await wait(250)
  try { ws.close() } catch (e) {}
}

describe("Node checks the header signature and proposer before per-transaction work", () => {
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

  // Eight funded senders, each spending once: a block whose per-transaction cost
  // is obvious. This is the work a forged block must not be able to buy.
  const SENDERS = [71, 72, 73, 74, 75, 76, 77, 78]
  const opening = funded(SENDERS)

  function bulkBlock(): Block {
    return createBlock(
      blockHash(genesis),
      1,
      SENDERS.map((seedByte) => signedTx(seedByte, { recipient: "carol", amount: 1, nonce: 1 }))
    )
  }

  beforeEach(() => {
    verifyTransactionMock.mockClear()
  })

  /**
   * Start a node, push one block frame at it from an anonymous socket, and
   * report where its tip ended up and how many transaction verifications the
   * frame cost it.
   */
  async function deliver(
    port: number,
    blk: Block,
    signer: Keypair | null,
    options?: { withValidators?: boolean; corruptSignature?: boolean }
  ) {
    const node = new Node(
      port,
      [],
      genesis,
      options && options.withValidators ? validators : [],
      opening
    )
    await wait(60)

    const envelope: Record<string, string> = {
      type: "blk",
      payloadHex: hex(new TextEncoder().encode(JSON.stringify(blk))),
    }
    if (signer) {
      let sig = signBlock(blk, signer)
      if (options && options.corruptSignature) {
        // One flipped byte: a signature of the right shape that verifies
        // against nothing.
        sig = Uint8Array.from(sig)
        sig[0] = sig[0] ^ 0xff
      }
      envelope.sigHex = hex(sig)
      envelope.pubKeyHex = hex(signer.publicKey)
    }

    await sendFrame(port, envelope)

    const height = node.tip.height
    const txVerifications = verifyTransactionMock.mock.calls.length
    node.close()
    await wait(20)
    return { height, txVerifications }
  }

  it("verifies every transaction of a block it accepts", async () => {
    const out = await deliver(9151, bulkBlock(), proposer, { withValidators: true })
    expect(out.height).toBe(1)
    expect(out.txVerifications).toBe(SENDERS.length)
  }, 5000)

  it("does no per-transaction work for a block with no header signature", async () => {
    const out = await deliver(9161, bulkBlock(), null)
    expect(out.height).toBe(0)
    expect(out.txVerifications).toBe(0)
  }, 5000)

  it("does no per-transaction work for a block whose header signature is forged", async () => {
    const out = await deliver(9171, bulkBlock(), proposer, { corruptSignature: true })
    expect(out.height).toBe(0)
    expect(out.txVerifications).toBe(0)
  }, 5000)

  it("does no per-transaction work for a signed block from an unelected signer", async () => {
    // A real signature over the real header: only the ELECTION fails, and it
    // must fail before the eight verifications are spent.
    const out = await deliver(9181, bulkBlock(), outsider, { withValidators: true })
    expect(out.height).toBe(0)
    expect(out.txVerifications).toBe(0)
  }, 5000)

  it("still rejects a bad transaction inside a properly signed block", async () => {
    // The reorder must not weaken anything: with a valid header the block is
    // still verified transaction by transaction, and a tampered transaction
    // still drops the whole block.
    const good = signedTx(71, { recipient: "carol", amount: 1, nonce: 1 })
    // The same signature over a different recipient. The leaf, and so the root,
    // is recomputed over the edited transaction, so the block is well-formed
    // and only the transaction signature is wrong.
    const tampered = { ...good, recipient: "mallory" }
    const blk = createBlock(blockHash(genesis), 1, [tampered])

    const out = await deliver(9191, blk, proposer, { withValidators: true })
    expect(out.height).toBe(0)
    expect(out.txVerifications).toBe(1)
  }, 5000)
})
