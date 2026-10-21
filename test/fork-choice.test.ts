import WebSocket from "ws"
import { Block, blockHash, createBlock, createGenesisBlock } from "../src/block"
import { canonicalBlockEncoding } from "../src/coding/serialize"
import { Keypair, keypairFromSeed, sign } from "../src/crypto/ed25519"
import { Node, PROPOSER_SLOT_MS } from "../src/node"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { closeAll, waitForPeers, waitUntil } from "./helpers/gossip"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * The fork-choice rule AS IMPLEMENTED (SPEC.md, "Fork choice and proposer
 * eligibility, as implemented"):
 *
 *   A node extends its own tip with the FIRST block it sees that passes every
 *   acceptance rule — including that the block's signer is the validator
 *   elected for (tip, round) — and never reorganises: a competing block at the
 *   same height, and any chain built on one, is refused for ever, however long
 *   that chain grows.
 *
 * So among competing blocks at one height the rule is decided by ELIGIBILITY
 * first (the elected proposer's block wins however the blocks are ordered on
 * the wire) and by ARRIVAL only between blocks that are both eligible (the
 * same proposer equivocating, or two rounds' winners). Both halves are pinned
 * here, in process and over a real gossip socket. Ports 9761-9762 are used by
 * no other test file.
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

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex")
}

/** A raw wire envelope, exactly as src/gossip/ws.ts frames one. */
function envelope(blk: Block, signer: Keypair): string {
  const payload = new TextEncoder().encode(JSON.stringify(blk))
  return JSON.stringify({
    type: "blk",
    payloadHex: hex(payload),
    sigHex: hex(signBlock(blk, signer)),
    pubKeyHex: hex(signer.publicKey),
  })
}

const alice = kp(11)
const bob = kp(22)
const validators: Validator[] = [
  { publicKey: publicKeyToHex(alice.publicKey), stake: 50 },
  { publicKey: publicKeyToHex(bob.publicKey), stake: 50 },
]
const genesis = createGenesisBlock()
const NOW = 1_700_000_000_000
/** Competing blocks are stamped like genesis, so they sit in round 0 of their parent. */
const STAMP = genesis.timestamp

/** The validator elected to extend `parent` in `round`. */
function electedFor(parent: Block, round: number): Keypair {
  const who = selectValidator(validators, proposerSeed(parent, round))
  expect(who).not.toBeNull()
  return who === publicKeyToHex(alice.publicKey) ? alice : bob
}
function otherThan(k: Keypair): Keypair {
  return k === alice ? bob : alice
}

/** Round 0 at height 1 is fixed by genesis; find a round whose winner differs. */
function roundWonByTheOther(parent: Block, loser: Keypair): number {
  for (let r = 1; r < 32; r++) if (electedFor(parent, r) !== loser) return r
  throw new Error("no round within 32 elects the other validator")
}

describe("fork choice as implemented: eligibility first, then first-seen, never a reorg", () => {
  it("the elected proposer's block wins however the two competitors are ordered", async () => {
    const node = new Node(9761, [], genesis, validators, funded([12]), { now: () => NOW })
    try {
      const winner = electedFor(genesis, 0)
      const loser = otherThan(winner)
      const fromLoser = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "x", amount: 1, nonce: 1 })], STAMP)
      const fromWinner = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "y", amount: 2, nonce: 1 })], STAMP)

      // loser first: refused, so the tip does not move
      expect(node.acceptBlock(fromLoser, signBlock(fromLoser, loser), loser.publicKey)).toBe(false)
      expect(node.tip.height).toBe(0)
      // winner second: accepted
      expect(node.acceptBlock(fromWinner, signBlock(fromWinner, winner), winner.publicKey)).toBe(true)
      expect(blockHash(node.tip)).toBe(blockHash(fromWinner))
      expect(node.balances.balanceOf("y")).toBe(2)
      expect(node.balances.balanceOf("x")).toBe(0)
    } finally {
      await closeAll(node)
    }
  })

  it("between two valid blocks at one height the first seen wins, and the other chain is never adopted", async () => {
    const node = new Node(9761, [], genesis, validators, funded([12]), { now: () => NOW })
    try {
      const winner = electedFor(genesis, 0)
      // the elected proposer equivocates: two different valid blocks at height 1
      const a1 = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "a", amount: 1, nonce: 1 })], STAMP)
      const b1 = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "b", amount: 1, nonce: 1 })], STAMP)
      expect(blockHash(a1)).not.toBe(blockHash(b1))

      expect(node.acceptBlock(a1, signBlock(a1, winner), winner.publicKey)).toBe(true)
      expect(node.acceptBlock(b1, signBlock(b1, winner), winner.publicKey)).toBe(false)
      expect(blockHash(node.tip)).toBe(blockHash(a1))

      // chain B grows longer than chain A: still refused, block by block, and
      // the node's own state stays on chain A
      let parent = b1
      for (let h = 2; h <= 4; h++) {
        const proposer = electedFor(parent, 0)
        const bh = createBlock(blockHash(parent), h, [], STAMP)
        expect(node.acceptBlock(bh, signBlock(bh, proposer), proposer.publicKey)).toBe(false)
        parent = bh
      }
      expect(node.tip.height).toBe(1)
      expect(blockHash(node.tip)).toBe(blockHash(a1))
      expect(node.chain.size).toBe(1)
      expect(blockHash(node.chain.get(1)!.block)).toBe(blockHash(a1))
      expect(node.balances.balanceOf("a")).toBe(1)
      expect(node.balances.balanceOf("b")).toBe(0)

      // chain A can still be extended by its own elected proposer
      const a2proposer = electedFor(a1, 0)
      const a2 = createBlock(blockHash(a1), 2, [], STAMP)
      expect(node.acceptBlock(a2, signBlock(a2, a2proposer), a2proposer.publicKey)).toBe(true)
      expect(node.tip.height).toBe(2)
    } finally {
      await closeAll(node)
    }
  })

  it("a later round's winner is eligible too, so two rounds' blocks are both valid and the first seen wins", async () => {
    const node = new Node(9761, [], genesis, validators, funded([12]), {
      now: () => NOW + 40 * PROPOSER_SLOT_MS, // the node's clock allows any round below
    })
    try {
      const round0 = electedFor(genesis, 0)
      const r = roundWonByTheOther(genesis, round0)
      const roundR = electedFor(genesis, r)
      expect(roundR).not.toBe(round0)

      const inRound0 = createBlock(blockHash(genesis), 1, [], genesis.timestamp)
      const inRoundR = createBlock(blockHash(genesis), 1, [], genesis.timestamp + r * PROPOSER_SLOT_MS)

      // the round-R winner cannot sign a round-0 block...
      expect(node.acceptBlock(inRound0, signBlock(inRound0, roundR), roundR.publicKey)).toBe(false)
      // ...but its own round-R block is valid, and once seen first it holds
      expect(node.acceptBlock(inRoundR, signBlock(inRoundR, roundR), roundR.publicKey)).toBe(true)
      expect(node.acceptBlock(inRound0, signBlock(inRound0, round0), round0.publicKey)).toBe(false)
      expect(blockHash(node.tip)).toBe(blockHash(inRoundR))
    } finally {
      await closeAll(node)
    }
  })

  it("over gossip: an unelected competitor sent first is dropped and the elected block that follows lands", async () => {
    const node = new Node(9762, [], genesis, validators, funded([12]), { now: () => NOW })
    let sock: WebSocket | undefined
    try {
      const winner = electedFor(genesis, 0)
      const loser = otherThan(winner)
      const fromLoser = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "x", amount: 1, nonce: 1 })], STAMP)
      const fromWinner = createBlock(blockHash(genesis), 1, [signedTx(12, { recipient: "y", amount: 2, nonce: 1 })], STAMP)

      const ws = new WebSocket("ws://127.0.0.1:9762")
      sock = ws
      await new Promise((res) => ws.on("open", res))
      await waitForPeers(node, { inbound: 1 }, undefined, "node")
      ws.send(envelope(fromLoser, loser))
      ws.send(envelope(fromWinner, winner))
      await waitUntil(() => node.tip.height >= 1, "the node to accept the elected block")

      expect(blockHash(node.tip)).toBe(blockHash(fromWinner))
      expect(node.balances.balanceOf("y")).toBe(2)
      expect(node.balances.balanceOf("x")).toBe(0)
      expect(node.nonces.lastNonce(accountHex(12))).toBe(1)
    } finally {
      await closeAll(
        sock && {
          close: () =>
            new Promise<void>((resolve) => {
              if (sock!.readyState === WebSocket.CLOSED) return resolve()
              sock!.once("close", () => resolve())
              sock!.close()
            }),
        },
        node
      )
    }
  }, 10000)
})
