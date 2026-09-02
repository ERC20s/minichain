import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, createBlock } from "./block"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { verify } from "./crypto/ed25519"
import { Transaction } from "./types/transaction"
import { Validator, selectValidator, publicKeyToHex } from "./validators"

export class Node {
  gossip: GossipNode
  tip: Block
  // when non-empty, only the stake-weighted selected proposer may extend the chain
  validators: Validator[]

  constructor(port: number, peers: string[], genesis: Block, validators?: Validator[]) {
    this.gossip = startGossipNode(port, peers)
    this.tip = genesis
    this.validators = Array.isArray(validators) ? validators.slice() : []

    this.gossip.on("blk", (m) => {
      try {
        // payload is JSON-encoded Block
        const s = new TextDecoder().decode(m.payload)
        const blk = JSON.parse(s) as Block

        // basic linkage: must be exactly tip.height + 1
        if (typeof blk.height !== "number" || blk.height !== this.tip.height + 1) return
        if (typeof blk.parentHash !== "string" || blk.parentHash !== this.tip.merkleRoot) return

        // recompute merkle root from transactions
        const txBytes: Uint8Array[] = (blk.transactions || []).map((tx: Transaction) => {
          return new TextEncoder().encode(JSON.stringify(tx))
        })
        const mr = merkleRoot(txBytes)
        if (mr !== blk.merkleRoot) return

        // require signature and pubKey
        if (!m.sig || !m.pubKey) return

        const header: CanonicalBlockHeader = {
          parentHash: blk.parentHash,
          height: blk.height,
          timestamp: blk.timestamp,
          merkleRoot: blk.merkleRoot,
          proposerPublicKey: m.pubKey,
        }
        const msg = canonicalBlockEncoding(header)
        const ok = verify(msg, m.sig, m.pubKey)
        if (!ok) return

        // proposer eligibility: with a validator set configured, the signer must
        // be the stake-weighted selection for this height
        if (this.validators.length > 0) {
          const expected = selectValidator(this.validators, this.proposerSeed(blk))
          if (!expected) return
          if (publicKeyToHex(expected) !== publicKeyToHex(m.pubKey)) return
        }

        // accept block
        this.tip = blk

        // re-broadcast to propagate
        this.gossip.broadcast("blk", m.payload, { sig: m.sig, pubKey: m.pubKey })
      } catch (e) {
        // ignore malformed
      }
    })
  }

  /**
   * Seed for stake-weighted proposer selection at a given block.
   *
   * Deterministic and derivable by every node from data it already has:
   * the UTF-8 bytes of `parentHash + ":" + height`. It is NOT a bias-resistant
   * randomness beacon — see SPEC.md, "Proposer eligibility".
   */
  proposerSeed(blk: Pick<Block, "parentHash" | "height">): Uint8Array {
    return new TextEncoder().encode(`${blk.parentHash}:${blk.height}`)
  }

  /** The validator expected to propose the block that extends the current tip. */
  expectedProposer(height?: number): string | null {
    if (this.validators.length === 0) return null
    const h = typeof height === "number" ? height : this.tip.height + 1
    return selectValidator(this.validators, this.proposerSeed({ parentHash: this.tip.merkleRoot, height: h }))
  }

  // helper to broadcast a signed block from this node
  broadcastBlock(blk: Block, sig?: Uint8Array, pubKey?: Uint8Array) {
    const payload = new TextEncoder().encode(JSON.stringify(blk))
    this.gossip.broadcast("blk", payload, sig && pubKey ? { sig, pubKey } : undefined)
  }

  close() {
    try { this.gossip.close() } catch (e) {}
  }
}
