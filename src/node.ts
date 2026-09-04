import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, blockHash, createBlock, transactionLeaves } from "./block"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { verify } from "./crypto/ed25519"
import { verifyTransaction } from "./tx"
import { Transaction } from "./types/transaction"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "./validators"

export class Node {
  gossip: GossipNode
  tip: Block
  /** The staked set this node enforces. Empty = no proof-of-stake check. */
  validators: Validator[]

  constructor(port: number, peers: string[], genesis: Block, validators: Validator[] = []) {
    this.gossip = startGossipNode(port, peers)
    this.tip = genesis
    this.validators = Array.isArray(validators) ? validators : []

    this.gossip.on("blk", (m) => {
      try {
        // payload is JSON-encoded Block
        const s = new TextDecoder().decode(m.payload)
        const blk = JSON.parse(s) as Block

        // basic linkage: must be exactly tip.height + 1
        if (typeof blk.height !== "number" || blk.height !== this.tip.height + 1) return
        // and must name THIS tip by its block hash. The tip's merkleRoot commits
        // only to its transactions, so it linked a child equally well to any
        // block carrying the same transaction list (every empty block shares
        // one root); the header hash is unique to the block.
        if (typeof blk.parentHash !== "string" || blk.parentHash !== blockHash(this.tip)) return

        // recompute merkle root from transactions.
        //
        // The leaves are the CANONICAL transaction encoding, the same bytes a
        // transaction signature is made over — not JSON.stringify, which
        // preserves key order (one transaction, two roots) and turns NaN and
        // Infinity into null (a block committing to amount: NaN recomputed to
        // the same root on every node and was accepted). canonicalEncoding
        // throws on anything it cannot represent, so a block carrying an
        // unencodable transaction is DROPPED here: the tip does not move and
        // nothing is re-broadcast.
        const txs = (blk.transactions || []) as Transaction[]
        let txBytes: Uint8Array[]
        try {
          txBytes = transactionLeaves(txs)
        } catch (e) {
          return
        }
        const mr = merkleRoot(txBytes)
        if (mr !== blk.merkleRoot) return

        // per-transaction authorisation.
        //
        // The root above proves the block commits to exactly these transactions
        // and the header signature below proves WHO proposed the block — neither
        // says the sender agreed to be debited. Without this check an elected
        // proposer could mint {sender: "alice", recipient: "me", amount: 1e6}
        // and every node would accept and relay it. Each transaction must carry
        // an ed25519 signature that verifies against the public key its own
        // `sender` field names; one failure drops the whole block, so the tip
        // does not move and nothing is re-broadcast.
        for (const tx of txs) {
          if (!verifyTransaction(tx)) return
        }

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

        // proof of stake: a valid signature only proves WHO signed the block,
        // not that they were entitled to propose it. When this node is
        // configured with a validator set, the signer must be the validator the
        // stake-weighted selector elects for this height — the seed being the
        // CURRENT tip's block hash, so the check runs before this.tip moves and
        // before anything is re-broadcast to peers.
        if (this.validators.length > 0) {
          const elected = selectValidator(this.validators, proposerSeed(this.tip))
          // A set that yields no proposer (all stakes zero, a malformed entry)
          // elects nobody, so nothing extends the chain: failing closed here is
          // safer than falling back to "any signature will do".
          if (elected === null) return
          if (elected.toLowerCase() !== publicKeyToHex(m.pubKey)) return
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

  // helper to broadcast a signed block from this node
  broadcastBlock(blk: Block, sig?: Uint8Array, pubKey?: Uint8Array) {
    const payload = new TextEncoder().encode(JSON.stringify(blk))
    this.gossip.broadcast("blk", payload, sig && pubKey ? { sig, pubKey } : undefined)
  }

  close() {
    try { this.gossip.close() } catch (e) {}
  }
}
