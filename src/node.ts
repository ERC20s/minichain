import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, blockHash, createBlock, transactionLeaves } from "./block"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { verify } from "./crypto/ed25519"
import { BalanceLedger, OpeningBalances } from "./state/balances"
import { Mempool, MempoolOptions, MempoolResult } from "./state/mempool"
import { NonceLedger } from "./state/nonces"
import { verifyTransaction } from "./tx"
import { Transaction } from "./types/transaction"
import { Validator, proposerSeed, publicKeyToHex, selectValidator } from "./validators"

/**
 * How far ahead of this node's own clock an incoming block may be stamped, in
 * milliseconds. Two minutes: wide enough for ordinary clock skew between honest
 * peers on unsynchronised boxes, narrow enough that the timestamp search a
 * proposer can run against the next height's seed is bounded (see
 * proposerSeed in src/validators.ts — the seed is the parent's block hash, and
 * the block hash covers the timestamp).
 */
export const MAX_FUTURE_DRIFT_MS = 120000

/** Optional knobs, mainly so tests can inject a clock and a tighter bound. */
export interface NodeOptions {
  /** Overrides MAX_FUTURE_DRIFT_MS. Must be a non-negative safe integer. */
  maxFutureDriftMs?: number
  /** Overrides Date.now, so a test can place "now" wherever it likes. */
  now?: () => number
  /** Overrides the mempool caps (see src/state/mempool.ts). */
  mempool?: MempoolOptions
}

export class Node {
  gossip: GossipNode
  tip: Block
  /** The accepted future drift for block timestamps, in milliseconds. */
  maxFutureDriftMs: number
  /** This node's clock. Injectable so tests do not have to wait for real time. */
  now: () => number
  /** The staked set this node enforces. Empty = no proof-of-stake check. */
  validators: Validator[]
  /**
   * Last accepted nonce per sender, seeded from genesis. A signature proves a
   * transfer was authorised; this is the only thing that proves it is fresh.
   */
  nonces: NonceLedger
  /**
   * Balance per account, seeded from genesis (which mints) and from any opening
   * balances this node was constructed with. A signature proves a transfer was
   * authorised and the nonce proves it is fresh; this is the only thing that
   * proves it is affordable.
   */
  balances: BalanceLedger
  /**
   * Transactions that are not in a block yet: validated against exactly the
   * rules below (signature, nonce, balance), bounded, and relayed once. See
   * src/state/mempool.ts — it holds pending transfers and moves no state.
   */
  mempool: Mempool

  constructor(
    port: number,
    peers: string[],
    genesis: Block,
    validators: Validator[] = [],
    openingBalances?: OpeningBalances,
    options?: NodeOptions
  ) {
    this.gossip = startGossipNode(port, peers)
    this.tip = genesis
    const drift = options && options.maxFutureDriftMs
    this.maxFutureDriftMs =
      typeof drift === "number" && Number.isSafeInteger(drift) && drift >= 0
        ? drift
        : MAX_FUTURE_DRIFT_MS
    this.now = options && typeof options.now === "function" ? options.now : () => Date.now()
    this.validators = Array.isArray(validators) ? validators : []
    this.nonces = new NonceLedger(genesis ? genesis.transactions : [])
    this.balances = new BalanceLedger(genesis ? genesis.transactions : [], openingBalances)
    this.mempool = new Mempool(this.nonces, this.balances, options && options.mempool)

    // pending transactions.
    //
    // The transport has always accepted this frame type (ALLOWED_TYPES =
    // {"tx", "blk"}, src/gossip/ws.ts) and nothing listened for it, so a
    // gossiped transaction was decoded, emitted and dropped on the floor. It is
    // admitted to the pool here under the SAME rules a block is judged by — the
    // ed25519 transaction signature, a nonce strictly above what this node has
    // accepted for the sender, and a balance that covers the amount together
    // with that sender's other pending transfers — and re-broadcast ONLY on
    // first admission. A transaction that is already pending, or that fails a
    // rule, is not relayed, so two peers cannot bounce one between them for
    // ever. Nothing here touches the tip or writes a ledger.
    this.gossip.on("tx", (m) => {
      try {
        // payload is a JSON-encoded signed Transaction
        const s = new TextDecoder().decode(m.payload)
        const tx = JSON.parse(s) as Transaction
        if (!this.mempool.add(tx).admitted) return
        // relay the bytes as they arrived: re-encoding could reorder keys and
        // the signature is over the canonical body, not over this JSON.
        this.gossip.broadcast("tx", m.payload)
      } catch (e) {
        // ignore malformed
      }
    })

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

        // timestamp bounds.
        //
        // Every other header field was checked and this one was only copied
        // into the header the signature is verified over, so a proposer could
        // stamp a block with any integer at all. That mattered twice: the
        // proposer seed for the NEXT height is "pos:" || blockHash(this block),
        // and blockHash covers the timestamp, so an unbounded stamp is an
        // unbounded search over who is elected after you; and a block stamped
        // in the year 3000, or before its own parent, makes the chain's own
        // ordering meaningless.
        //
        // Three cheap checks, run before the Merkle recompute and the
        // signature work: the stamp must be a real (non-negative, safe)
        // integer, it must not go BACKWARDS from the tip (equal is allowed —
        // blocks minted in the same millisecond are ordinary), and it must not
        // be further ahead of this node's clock than maxFutureDriftMs. A
        // failing block is dropped exactly like any other: the tip does not
        // move and nothing is re-broadcast.
        if (typeof blk.timestamp !== "number" || !Number.isSafeInteger(blk.timestamp)) return
        if (blk.timestamp < 0) return
        const parentStamp = this.tip ? this.tip.timestamp : 0
        if (typeof parentStamp === "number" && Number.isFinite(parentStamp)) {
          if (blk.timestamp < parentStamp) return
        }
        if (blk.timestamp > this.now() + this.maxFutureDriftMs) return

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

        // replay protection.
        //
        // A signature proves the sender consented to THESE bytes; it never
        // expires, so the identical signed object verifies for ever. Without the
        // check below a proposer could put an already-accepted transaction into
        // the next block, or the same one twice into this one, and every check
        // above still passed — same leaves, same root, same header signature,
        // same elected proposer — so the transfer happened again.
        //
        // Each sender's nonce must be STRICTLY greater than the last one this
        // node accepted for it, counting transactions earlier in the same block.
        // Staging touches no state: the ledger is written only at the accept
        // point below, so a block dropped by the header-signature or proposer
        // check cannot burn nonces the chain never spent.
        const staged = this.nonces.stage(txs)
        if (staged === null) return

        // solvency.
        //
        // The checks above prove the block commits to these transactions, that
        // each sender consented to its own, and that none of them is a replay.
        // None of them proves the money exists: an elected proposer could sign a
        // fresh, correctly nonced transfer of 1e15 from an account that has
        // never been credited and every check so far still passed, so the tip
        // moved and the node relayed value created out of nothing.
        //
        // Each sender's running balance — genesis mints plus whatever it has
        // received, minus what it has spent, counting transactions earlier in
        // this same block — must cover the amount. One overdraft drops the WHOLE
        // block. Staging touches no state; the ledger is written only at the
        // accept point below, so a block dropped by the header-signature or
        // proposer check cannot spend balances the chain never spent.
        const stagedBalances = this.balances.stage(txs)
        if (stagedBalances === null) return

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

        // accept block: the tip moves and the nonces and balances this block
        // spent are written together, so the three can never disagree.
        this.tip = blk
        this.nonces.commit(staged)
        this.balances.commit(stagedBalances)
        // and the pool forgets what this block committed, plus anything the new
        // nonces just made impossible. Run after the commits, so it reads the
        // ledgers at the new tip.
        this.mempool.drop(txs)

        // re-broadcast to propagate
        this.gossip.broadcast("blk", m.payload, { sig: m.sig, pubKey: m.pubKey })
      } catch (e) {
        // ignore malformed
      }
    })
  }

  /**
   * Offer a locally built transaction to this node.
   *
   * It goes through the same pool rules as anything off the wire — no local
   * shortcut — and is broadcast to peers only if this node admits it, so a
   * transaction this node would itself refuse is never pushed at the network.
   * Returns the pool's answer, so a caller can see WHY a transfer was refused.
   */
  submitTransaction(tx: Transaction): MempoolResult {
    const result = this.mempool.add(tx)
    if (result.admitted) {
      const payload = new TextEncoder().encode(JSON.stringify(tx))
      this.gossip.broadcast("tx", payload)
    }
    return result
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
