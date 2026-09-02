import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, blockHash } from "./block"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { verify } from "./crypto/ed25519"
import { Transaction } from "./types/transaction"

export class Node {
  gossip: GossipNode
  tip: Block
  // identity of the current tip: children must name this in parentHash
  tipHash: string

  constructor(port: number, peers: string[], genesis: Block) {
    this.gossip = startGossipNode(port, peers)
    this.tip = genesis
    this.tipHash = blockHash(genesis)

    this.gossip.on("blk", (m) => {
      try {
        // payload is JSON-encoded Block
        const s = new TextDecoder().decode(m.payload)
        const blk = JSON.parse(s) as Block

        // basic linkage: must be exactly tip.height + 1
        if (typeof blk.height !== "number" || blk.height !== this.tip.height + 1) return
        // and must name the tip by its block hash (not by the tip's merkle root)
        if (typeof blk.parentHash !== "string" || blk.parentHash !== this.tipHash) return

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

        // accept block
        this.tip = blk
        this.tipHash = blockHash(blk)

        // re-broadcast to propagate
        this.gossip.broadcast("blk", m.payload, { sig: m.sig, pubKey: m.pubKey })
      } catch (e) {
        // ignore malformed
      }
    })
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
