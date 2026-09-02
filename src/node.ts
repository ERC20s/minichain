import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, blockMerkleRoot } from "./block"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { verify } from "./crypto/ed25519"

export class Node {
  gossip: GossipNode
  tip: Block

  constructor(port: number, peers: string[], genesis: Block) {
    this.gossip = startGossipNode(port, peers)
    this.tip = genesis

    this.gossip.on("blk", (m) => {
      try {
        // payload is JSON-encoded Block
        const s = new TextDecoder().decode(m.payload)
        const blk = JSON.parse(s) as Block

        // basic linkage: must be exactly tip.height + 1
        if (typeof blk.height !== "number" || blk.height !== this.tip.height + 1) return
        if (typeof blk.parentHash !== "string" || blk.parentHash !== this.tip.merkleRoot) return

        // recompute merkle root from transactions, using the same canonical
        // leaf bytes the proposer used (see blockMerkleRoot in src/block.ts)
        const mr = blockMerkleRoot(blk.transactions || [])
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
