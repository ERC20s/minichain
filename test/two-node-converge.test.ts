import { Block, blockHash, createGenesisBlock } from "../src/block"
import { Keypair, keypairFromSeed } from "../src/crypto/ed25519"
import { Node, PROPOSER_SLOT_MS } from "../src/node"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "../src/validators"
import { closeAll, waitForPeers, waitUntil } from "./helpers/gossip"
import { accountHex, funded, signedTx } from "./helpers/signed-tx"

/**
 * Two validators on two ports, each minting on its own timer, converge on one
 * head — and every block on that head was minted by the validator the
 * stake-weighted rule elects for its parent and round (SPEC.md, "Fork choice
 * and proposer eligibility, as implemented").
 *
 * Both nodes share a FROZEN clock, so every block is stamped like its parent
 * and sits in round 0: the election at each height is then a pure function of
 * the parent's hash, which is what makes the chain below checkable block by
 * block. Ports 9771-9772 are used by no other test file.
 */
function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

describe("two nodes gossip blocks and converge on one head", () => {
  const alice = kp(11)
  const bob = kp(22)
  const validators: Validator[] = [
    { publicKey: publicKeyToHex(alice.publicKey), stake: 70 },
    { publicKey: publicKeyToHex(bob.publicKey), stake: 30 },
  ]
  const genesis = createGenesisBlock()
  const NOW = 1_700_000_000_000
  const TARGET = 8

  it("every height is minted by its elected validator and both nodes hold the same chain", async () => {
    const opening = funded([12])
    const a = new Node(9771, ["ws://127.0.0.1:9772"], genesis, validators, opening, { now: () => NOW })
    const b = new Node(9772, ["ws://127.0.0.1:9771"], genesis, validators, opening, { now: () => NOW })
    const minted = { alice: 0, bob: 0 }
    let tickA: NodeJS.Timeout | undefined
    let tickB: NodeJS.Timeout | undefined
    try {
      await waitForPeers(a, { inbound: 1, outbound: 1 }, undefined, "a")
      await waitForPeers(b, { inbound: 1, outbound: 1 }, undefined, "b")

      // a transfer offered to A: relayed to B, minted by whoever is elected
      expect(a.submitTransaction(signedTx(12, { recipient: "carol", amount: 5, nonce: 1 })).admitted).toBe(true)

      // each validator ticks on its own, exactly like examples/run-node.ts
      tickA = setInterval(() => {
        if (a.tip.height < TARGET && a.proposeBlock(alice.secretKey, alice.publicKey, { allowEmpty: true })) minted.alice++
      }, 30)
      tickB = setInterval(() => {
        if (b.tip.height < TARGET && b.proposeBlock(bob.secretKey, bob.publicKey, { allowEmpty: true })) minted.bob++
      }, 30)

      await waitUntil(() => a.tip.height >= TARGET && b.tip.height >= TARGET, `both tips to reach ${TARGET}`, 15000)
      clearInterval(tickA)
      clearInterval(tickB)
      tickA = tickB = undefined

      // one head
      await waitUntil(() => blockHash(a.tip) === blockHash(b.tip), "both tips to be one block", 5000)
      expect(a.tip.height).toBe(TARGET)
      expect(b.tip.height).toBe(TARGET)

      // one chain, and the rule held at every height: the sealing key is the
      // validator elected for the parent in the round the block's own stamp
      // sits in — max(0, floor((stamp - parent.stamp) / PROPOSER_SLOT_MS)).
      // Block 1 is stamped NOW against genesis (stamp 0), a high round; every
      // later block is stamped like its parent, round 0.
      let parent: Block = genesis
      for (let h = 1; h <= TARGET; h++) {
        const sa = a.chain.get(h)
        const sb = b.chain.get(h)
        expect(sa).toBeDefined()
        expect(sb).toBeDefined()
        expect(blockHash(sa!.block)).toBe(blockHash(sb!.block))
        expect(sa!.block.parentHash).toBe(blockHash(parent))
        expect(sa!.block.timestamp).toBe(NOW)
        const round = Math.max(0, Math.floor((sa!.block.timestamp - parent.timestamp) / PROPOSER_SLOT_MS))
        expect(round).toBe(h === 1 ? Math.floor(NOW / PROPOSER_SLOT_MS) : 0)
        const elected = selectValidator(validators, proposerSeed(parent, round))
        expect(publicKeyToHex(sa!.pubKey)).toBe(elected)
        expect(publicKeyToHex(sb!.pubKey)).toBe(elected)
        parent = sa!.block
      }
      expect(minted.alice + minted.bob).toBe(TARGET)

      // and one state: the transfer landed exactly once, on both ledgers
      expect(a.balances.balanceOf("carol")).toBe(5)
      expect(b.balances.balanceOf("carol")).toBe(5)
      expect(a.balances.balanceOf(accountHex(12))).toBe(1_000_000 - 5)
      expect(b.balances.balanceOf(accountHex(12))).toBe(1_000_000 - 5)
      expect(a.nonces.lastNonce(accountHex(12))).toBe(1)
      expect(b.nonces.lastNonce(accountHex(12))).toBe(1)
      expect(a.mempool.size).toBe(0)
      expect(b.mempool.size).toBe(0)
    } finally {
      if (tickA) clearInterval(tickA)
      if (tickB) clearInterval(tickB)
      await closeAll(a, b)
    }
  }, 30000)
})
