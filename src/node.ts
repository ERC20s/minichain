import { startGossipNode, GossipNode } from "./gossip/ws"
import { Block, blockHash, createBlock, transactionLeaves } from "./block"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, CanonicalBlockHeader } from "./coding/serialize"
import { sign, verify } from "./crypto/ed25519"
import { BalanceLedger, OpeningBalances } from "./state/balances"
import { ChainStore, DEFAULT_CHAIN_STORE_CAPACITY } from "./state/chain"
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

/** How many pending transactions a proposed block carries unless told otherwise. */
export const MAX_BLOCK_TRANSACTIONS = 256

/**
 * How long one proposer's slot lasts, in milliseconds.
 *
 * A CONSENSUS constant, deliberately not a NodeOptions knob: every node must
 * derive the same round from the same header, and a node with a different slot
 * length would elect a different proposer and fork.
 *
 * The round a candidate block sits in is
 * `max(0, floor((blk.timestamp - tip.timestamp) / PROPOSER_SLOT_MS))` and it is
 * mixed into the proposer seed (proposerSeed(parent, round) in
 * src/validators.ts). That is the whole liveness fix: the seed used to be a pure
 * function of the tip, so an elected validator that was offline, crashed or
 * partitioned froze the chain for ever — the tip never moved, so the seed never
 * changed, so the same absent validator was elected again at every attempt. With
 * a round, one slot after the tip a DIFFERENT validator is elected and the chain
 * carries on.
 *
 * 6000ms is comfortably above the runner's default PROPOSE_INTERVAL_MS (2000,
 * examples/run-node.ts): a slot has to be long enough that the elected proposer
 * gets several ticks to mint and to have its block reach its peers before anyone
 * else is entitled to the height, because this chain still has no fork choice.
 * MAX_FUTURE_DRIFT_MS (120000) bounds how far ahead a block may be stamped, so a
 * grinding proposer can reach at most 20 rounds beyond the accepting node's
 * clock, not an unbounded search.
 */
export const PROPOSER_SLOT_MS = 6000

/**
 * The most blocks ONE "req" frame is ever answered with.
 *
 * The answer is sent to the asker alone, but it is still work this node does on
 * a stranger's word, so the cap is the whole defence against amplification: a
 * one-line request can never cost more than 32 block sends. A peer further
 * behind than that asks again after it has applied what it got.
 */
export const MAX_SYNC_BLOCKS = 32

/**
 * The shortest gap between two catch-up requests from this node, in
 * milliseconds.
 *
 * Without it a node at height 0 watching a busy chain would fire a "req" at
 * every future block it saw — one per gossiped block, at every peer. One request
 * per second is far more often than a chain that mints every couple of seconds
 * needs, and it bounds what a lagging node costs the mesh.
 */
export const SYNC_REQUEST_INTERVAL_MS = 1000

/** Optional knobs for one call to proposeBlock. */
export interface ProposeOptions {
  /**
   * Cap on how many pooled transactions the block carries. Must be a positive
   * safe integer; anything else leaves MAX_BLOCK_TRANSACTIONS standing.
   */
  maxTransactions?: number
  /**
   * Mint even with an empty pool. Off by default: an idle chain should not fill
   * with empty blocks, and every empty block a proposer mints re-rolls the seed
   * that elects the next one.
   */
  allowEmpty?: boolean
}

/** Optional knobs, mainly so tests can inject a clock and a tighter bound. */
export interface NodeOptions {
  /** Overrides MAX_FUTURE_DRIFT_MS. Must be a non-negative safe integer. */
  maxFutureDriftMs?: number
  /** Overrides Date.now, so a test can place "now" wherever it likes. */
  now?: () => number
  /** Overrides the mempool caps (see src/state/mempool.ts). */
  mempool?: MempoolOptions
  /**
   * How many accepted blocks this node keeps for serving catch-up requests.
   * Must be a positive safe integer; anything else leaves
   * DEFAULT_CHAIN_STORE_CAPACITY (1024) standing.
   */
  chainCapacity?: number
  /**
   * Overrides SYNC_REQUEST_INTERVAL_MS, so a test does not have to wait a real
   * second. Must be a non-negative safe integer.
   */
  syncRequestIntervalMs?: number
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
  /**
   * The blocks this node has ACCEPTED, sealed with the header signature and
   * proposer key they arrived under, bounded to the last `chainCapacity`
   * heights. It exists so this node can answer a peer that fell behind; nothing
   * in the acceptance rules reads it. See src/state/chain.ts.
   */
  chain: ChainStore
  /** The shortest gap between two catch-up requests this node sends. */
  syncRequestIntervalMs: number
  /** When this node last sent a "req" frame, on its own clock. */
  private lastSyncRequestAt: number | undefined
  /**
   * The FIRST height the outstanding catch-up request asked for, or undefined
   * when no request is outstanding.
   *
   * One "req" is answered with at most MAX_SYNC_BLOCKS blocks, so a node further
   * behind than that has to ask again once it has applied the batch. This is the
   * only thing that lets it know a batch it received was FULL — the last height
   * of the window it asked for (from + MAX_SYNC_BLOCKS - 1) arrived, so there is
   * very likely more beyond it. See noticeSyncProgress below.
   */
  private syncRequestedFrom: number | undefined

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

    // Block history. Genesis is NOT put in: every node builds its own with
    // createGenesisBlock() and there is no seal to serve for it.
    const capacity = options && options.chainCapacity
    this.chain = new ChainStore(
      typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0
        ? capacity
        : DEFAULT_CHAIN_STORE_CAPACITY
    )
    const interval = options && options.syncRequestIntervalMs
    this.syncRequestIntervalMs =
      typeof interval === "number" && Number.isSafeInteger(interval) && interval >= 0
        ? interval
        : SYNC_REQUEST_INTERVAL_MS
    this.lastSyncRequestAt = undefined
    this.syncRequestedFrom = undefined

    // pending transactions.
    //
    // The transport has always accepted this frame type (ALLOWED_TYPES =
    // {"tx", "blk", "req"}, src/gossip/ws.ts) and nothing listened for it, so a
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

    // incoming blocks.
    //
    // The listener does three things and no more: decode the frame, hand it to
    // acceptBlock() — which holds every rule this chain has, in order — and, when
    // the block is refused because it is from the FUTURE, ask a peer for the gap.
    // A block is relayed ONLY when it moved this node's tip, exactly as before,
    // and the bytes relayed are the bytes that arrived: re-encoding could reorder
    // keys, and the header signature is over the canonical header, not over this
    // JSON.
    this.gossip.on("blk", (m) => {
      try {
        // payload is JSON-encoded Block
        const s = new TextDecoder().decode(m.payload)
        const blk = JSON.parse(s) as Block

        if (!this.acceptBlock(blk, m.sig, m.pubKey)) {
          // A refused block is usually junk — but a block whose height is more
          // than one above our tip is the one refusal that means WE are behind,
          // not that the sender is wrong. Before this, that block was dropped in
          // silence and the node never followed the chain again.
          this.noticeFutureBlock(blk)
          return
        }

        // The tip moved. If this block was the LAST one of a FULL catch-up
        // batch, our gap is almost certainly not closed — one request is
        // answered with at most MAX_SYNC_BLOCKS blocks and nothing used to ask
        // again, so a node 100 blocks behind stopped dead at 32.
        this.noticeSyncProgress(blk)

        // re-broadcast to propagate
        this.gossip.broadcast("blk", m.payload, { sig: m.sig, pubKey: m.pubKey })
      } catch (e) {
        // ignore malformed
      }
    })

    // catch-up requests from a peer that fell behind.
    //
    // The payload is {"from": <height>, "max": <count>}. This node answers with
    // up to MAX_SYNC_BLOCKS consecutive SEALED blocks from its own store, as
    // ordinary "blk" frames, sent to the ASKER alone (m.reply) — a peer's gap
    // must not cost the whole mesh a re-flood. Nothing is trusted and nothing is
    // shortcut: the answer travels the ordinary block path and the asker judges
    // every block with the same acceptBlock as any other.
    this.gossip.on("req", (m) => {
      try {
        const reply = m.reply
        // Nothing to answer over: a frame that did not arrive on a socket we can
        // write back to is dropped rather than turned into a broadcast.
        if (typeof reply !== "function") return

        const s = new TextDecoder().decode(m.payload)
        const req = JSON.parse(s) as { from?: unknown; max?: unknown }
        if (!req || typeof req !== "object") return

        const from = req.from
        if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0) return

        // The asker may ask for fewer; it can never ask for more.
        const asked =
          typeof req.max === "number" && Number.isSafeInteger(req.max) && req.max > 0
            ? req.max
            : MAX_SYNC_BLOCKS
        const count = Math.min(asked, MAX_SYNC_BLOCKS)

        // range() stops at the first height this node does not hold, so a batch
        // never carries a hole the asker would stall on. An unheld `from`
        // answers nothing at all, which is the honest reply.
        for (const sealed of this.chain.range(from, count)) {
          // Re-serialised rather than relayed byte-for-byte: this node holds the
          // block, not the frame it arrived in. That is safe precisely because
          // nothing signs this JSON — the header signature is over
          // canonicalBlockEncoding and the Merkle root is recomputed from the
          // transactions, so key order on the wire is irrelevant.
          const payload = new TextEncoder().encode(JSON.stringify(sealed.block))
          reply("blk", payload, { sig: sealed.sig, pubKey: sealed.pubKey })
        }
      } catch (e) {
        // ignore malformed
      }
    })

    // a peer link came up: ask for the gap straight away.
    //
    // The transport re-dials a peer that was not listening yet, or that
    // restarted (src/gossip/ws.ts), and fires this when the socket opens. That
    // moment is exactly when this node is most likely to be behind, and until
    // now nothing asked: the only trigger for a catch-up request was REFUSING a
    // future block, so a node that reconnected to a quiet chain sat at its old
    // tip until the next block happened to be minted.
    //
    // Nothing here is unbounded: requestSync() is rate limited to one request
    // per syncRequestIntervalMs on this node's own clock, so several peers
    // opening at once still produce one "req", and an answer is capped at
    // MAX_SYNC_BLOCKS blocks judged by the ordinary acceptBlock path.
    try {
      this.gossip.onPeerOpen(() => {
        this.requestSync()
      })
    } catch (e) {
      // a transport without the hook simply keeps the old behaviour
    }
  }

  /**
   * A block we refused arrived from above our tip: ask for what is missing.
   *
   * Called only from the "blk" listener, only for a block acceptBlock said no
   * to. A height of exactly tip.height + 1 that was refused is a BAD block (bad
   * signature, bad root, bad nonce) and must not trigger anything; only a height
   * strictly above that means this node is missing a link.
   */
  private noticeFutureBlock(blk: Block): void {
    if (!blk || typeof blk !== "object") return
    if (typeof blk.height !== "number" || !Number.isSafeInteger(blk.height)) return
    if (blk.height <= this.tip.height + 1) return
    this.requestSync()
  }

  /**
   * A block we ACCEPTED arrived while a catch-up request was outstanding: if it
   * completed a full batch, ask for the next one.
   *
   * Called only from the "blk" listener, only after acceptBlock() returned true,
   * so a block this node MINTED itself (proposeBlock calls acceptBlock directly)
   * can never trigger a request — a proposer is not behind.
   *
   * The rule is the arithmetic of the answer. requestSync() asks for
   * {from, max: MAX_SYNC_BLOCKS} and the responder serves at most
   * MAX_SYNC_BLOCKS consecutive blocks, so the last height of a FULL batch is
   * exactly `from + MAX_SYNC_BLOCKS - 1`. Reaching it means the answer was
   * capped, not exhausted: clear the outstanding marker AND the rate-limit stamp
   * (32 blocks arrive back to back, far inside syncRequestIntervalMs, so the
   * limiter would otherwise swallow the follow-up) and ask again from the new
   * tip. A SHORT batch never reaches that height, so a node that has caught up
   * stops asking on its own — the chain of requests ends itself.
   *
   * A block accepted from OUTSIDE the window the request covered means the
   * marker is stale (the tip moved on by ordinary gossip); it is cleared without
   * asking. Never throws.
   */
  private noticeSyncProgress(blk: Block): void {
    try {
      const from = this.syncRequestedFrom
      if (from === undefined) return
      if (!blk || typeof blk !== "object") return
      if (typeof blk.height !== "number" || !Number.isSafeInteger(blk.height)) return

      const lastOfBatch = from + MAX_SYNC_BLOCKS - 1
      // Below the window: this request has not been answered yet in any way we
      // can read. Above it: the marker belongs to a request we have long since
      // outrun, so drop it rather than re-ask on stale arithmetic.
      if (blk.height < from) return
      if (blk.height > lastOfBatch) {
        this.syncRequestedFrom = undefined
        return
      }
      if (blk.height < lastOfBatch) return

      // A full batch. There is more of the chain past it more often than not.
      this.syncRequestedFrom = undefined
      this.lastSyncRequestAt = undefined
      this.requestSync()
    } catch (e) {
      // a catch-up that cannot continue must never break block acceptance
    }
  }

  /**
   * Ask peers for the blocks between this node's tip and whatever they hold.
   *
   * Broadcasts one "req" frame naming the FIRST height this node needs
   * (tip.height + 1) and how many it will take (MAX_SYNC_BLOCKS). Rate limited
   * to one request per syncRequestIntervalMs on this node's own (injectable)
   * clock, so a node far behind a busy chain asks once a second rather than once
   * per block it cannot use.
   *
   * A request that goes out is REMEMBERED (syncRequestedFrom), because the
   * answer is capped at MAX_SYNC_BLOCKS blocks: noticeSyncProgress above uses
   * that height to tell a full batch from a short one and to ask again until the
   * gap is actually closed.
   *
   * Returns true when a request actually went out. Never throws.
   */
  requestSync(): boolean {
    try {
      const clock = this.now()
      const at = typeof clock === "number" && Number.isFinite(clock) ? clock : Date.now()
      if (
        this.lastSyncRequestAt !== undefined &&
        at - this.lastSyncRequestAt < this.syncRequestIntervalMs
      ) {
        return false
      }
      this.lastSyncRequestAt = at

      const from = this.tip.height + 1
      const payload = new TextEncoder().encode(JSON.stringify({ from, max: MAX_SYNC_BLOCKS }))
      this.gossip.broadcast("req", payload)
      // Remembered so the batch that answers can be recognised as full.
      this.syncRequestedFrom = from
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Which proposer ROUND a block stamped `timestamp` sits in, measured from
   * THIS node's current tip.
   *
   * `max(0, floor((timestamp - tip.timestamp) / PROPOSER_SLOT_MS))`. Derived,
   * never carried: nothing in the header names a round, so no encoding,
   * signature preimage, block hash or Merkle rule changes and two honest nodes
   * on the same tip read the same round out of the same block. A stamp at or
   * behind the parent (acceptBlock allows equal) is round 0, which is
   * byte-for-byte the election this chain has always run.
   *
   * Public so a proposer loop, a test or a future RPC can ask "whose slot is it
   * now?" without duplicating the arithmetic. Never throws.
   */
  proposerRound(timestamp: number): number {
    try {
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return 0
      const parentStamp =
        this.tip && typeof this.tip.timestamp === "number" && Number.isFinite(this.tip.timestamp)
          ? this.tip.timestamp
          : 0
      const elapsed = timestamp - parentStamp
      if (!(elapsed >= PROPOSER_SLOT_MS)) return 0
      const round = Math.floor(elapsed / PROPOSER_SLOT_MS)
      return Number.isSafeInteger(round) && round > 0 ? round : 0
    } catch (e) {
      return 0
    }
  }

  /**
   * Judge a block against every rule this chain has and, if it passes, make it
   * the tip.
   *
   * This is the ONE acceptance path. It used to be the body of the gossip "blk"
   * listener; it is a method so that a block this node MINTS (proposeBlock
   * below) is judged by exactly the same code, in exactly the same order, as a
   * block off the wire — a self-minted block that fails our own rules is never
   * broadcast, and there is no local shortcut into the chain.
   *
   * Returns true only when the tip moved. It never throws and it never
   * broadcasts: relaying is the caller's business, precisely because a caller
   * that has the original bytes should relay those bytes.
   */
  acceptBlock(blk: Block, sig?: Uint8Array, pubKey?: Uint8Array): boolean {
    try {
      if (!blk || typeof blk !== "object") return false

      // basic linkage: must be exactly tip.height + 1
      if (typeof blk.height !== "number" || blk.height !== this.tip.height + 1) return false
      // and must name THIS tip by its block hash. The tip's merkleRoot commits
      // only to its transactions, so it linked a child equally well to any
      // block carrying the same transaction list (every empty block shares
      // one root); the header hash is unique to the block.
      if (typeof blk.parentHash !== "string" || blk.parentHash !== blockHash(this.tip)) return false

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
      if (typeof blk.timestamp !== "number" || !Number.isSafeInteger(blk.timestamp)) return false
      if (blk.timestamp < 0) return false
      const parentStamp = this.tip ? this.tip.timestamp : 0
      if (typeof parentStamp === "number" && Number.isFinite(parentStamp)) {
        if (blk.timestamp < parentStamp) return false
      }
      if (blk.timestamp > this.now() + this.maxFutureDriftMs) return false

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
        return false
      }
      const mr = merkleRoot(txBytes)
      if (mr !== blk.merkleRoot) return false

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
        if (!verifyTransaction(tx)) return false
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
      if (staged === null) return false

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
      if (stagedBalances === null) return false

      // require signature and pubKey
      if (!sig || !pubKey) return false

      const header: CanonicalBlockHeader = {
        parentHash: blk.parentHash,
        height: blk.height,
        timestamp: blk.timestamp,
        merkleRoot: blk.merkleRoot,
        proposerPublicKey: pubKey,
      }
      const msg = canonicalBlockEncoding(header)
      const ok = verify(msg, sig, pubKey)
      if (!ok) return false

      // proof of stake: a valid signature only proves WHO signed the block,
      // not that they were entitled to propose it. When this node is
      // configured with a validator set, the signer must be the validator the
      // stake-weighted selector elects for this height — the seed being the
      // CURRENT tip's block hash, so the check runs before this.tip moves and
      // before anything is re-broadcast to peers.
      //
      // ...and for the ROUND this block's own timestamp sits in. Round 0
      // (a block stamped inside one slot of its parent) is exactly the seed
      // this chain always used; each further PROPOSER_SLOT_MS past the parent
      // re-rolls the election, so an elected validator that is offline no
      // longer freezes the chain for ever. The round is DERIVED from the
      // header — nothing claims it — and the timestamp it is derived from has
      // already been bounded above (not before the parent, not further ahead
      // than maxFutureDriftMs), so a block signed by the winner of a round its
      // stamp does not sit in fails right here.
      if (this.validators.length > 0) {
        const round = this.proposerRound(blk.timestamp)
        const elected = selectValidator(this.validators, proposerSeed(this.tip, round))
        // A set that yields no proposer (all stakes zero, a malformed entry)
        // elects nobody, so nothing extends the chain: failing closed here is
        // safer than falling back to "any signature will do".
        if (elected === null) return false
        if (elected.toLowerCase() !== publicKeyToHex(pubKey)) return false
      }

      // accept block: the tip moves and the nonces and balances this block
      // spent are written together, so the three can never disagree.
      this.tip = blk
      this.nonces.commit(staged)
      this.balances.commit(stagedBalances)
      // and the block is kept, sealed with the signature and key it was judged
      // under, so this node can hand it to a peer that fell behind. Written HERE
      // and nowhere else, so a self-minted block and a gossiped one are stored
      // by the same line, and only a block that passed every rule above is ever
      // served. Bounded to the last chainCapacity heights (src/state/chain.ts).
      this.chain.put(blk, sig, pubKey)
      // and the pool forgets what this block committed, plus anything the new
      // nonces just made impossible. Run after the commits, so it reads the
      // ledgers at the new tip.
      this.mempool.drop(txs)
      return true
    } catch (e) {
      // ignore malformed
      return false
    }
  }

  /**
   * Mint the next block from this node's own mempool, and gossip it.
   *
   * This is the first thing on this chain that PRODUCES a block. Thirteen cycles
   * hardened what a node accepts; nothing minted, so a transfer that reached the
   * pool stayed there for ever and `npm run dev` ran a chain whose height never
   * left 0.
   *
   * What it does, in order:
   *
   *  - STAMP FIRST. max(this node's clock, the parent's timestamp), so the
   *    block can never be stamped behind its own parent — the rule acceptBlock
   *    enforces. The clock is the node's injectable `now`, not Date.now. It is
   *    computed before anything else because it fixes the ROUND, and the round
   *    fixes who is elected.
   *  - ELECTION. When this node is configured with a validator set, the key
   *    offered here must be the validator selectValidator elects for the seed of
   *    the CURRENT tip AND the round that stamp sits in ("pos:" ||
   *    blockHash(tip) [|| ":" || round], src/validators.ts). Not elected — or a
   *    set that elects nobody — means null, and nothing is signed, so an
   *    unelected node never puts a block its peers must drop onto the wire. A
   *    node that loses round 0 mints nothing at this tick and may be elected at
   *    a later tick, once its clock has moved a whole PROPOSER_SLOT_MS past the
   *    parent — that is what stops one offline validator halting the chain.
   *  - CONTENT. Up to opts.maxTransactions (default MAX_BLOCK_TRANSACTIONS)
   *    pending transactions from mempool.selectForBlock(), which orders them by
   *    nonce so that each sender's own transactions stage in ascending order AND
   *    skips any entry that would not stage against the current ledgers. A block
   *    is judged all-or-nothing, so without that skip a single pending transfer
   *    its sender can no longer afford would stop this node minting anything, at
   *    every tick, for ever. A pool that selects nothing mints nothing unless
   *    opts.allowEmpty.
   *  - SELF-JUDGEMENT. The finished block goes through acceptBlock() like any
   *    other. Only if THIS node accepts it — linkage, timestamp, Merkle root,
   *    every transaction signature, nonces, balances, the header signature and
   *    the proposer check — is it broadcast. A block we would refuse from a peer
   *    is never one we send to a peer.
   *
   * Returns the accepted block, or null when nothing was minted. Never throws.
   */
  proposeBlock(secretKey: Uint8Array, publicKey: Uint8Array, opts?: ProposeOptions): Block | null {
    try {
      if (!(secretKey instanceof Uint8Array) || !(publicKey instanceof Uint8Array)) return null

      // STAMP FIRST, because the stamp is what decides the round, and the round
      // is what decides who is elected. Never behind the parent: acceptBlock
      // refuses a backwards stamp, and a proposer whose box is a second slow
      // would otherwise mint a block only it believes in.
      const clock = this.now()
      const base = typeof clock === "number" && Number.isFinite(clock) ? Math.floor(clock) : Date.now()
      const parentStamp =
        this.tip && typeof this.tip.timestamp === "number" && Number.isSafeInteger(this.tip.timestamp)
          ? this.tip.timestamp
          : 0
      const timestamp = Math.max(base, parentStamp)

      // Elected? Checked before any work, and against the same seed acceptBlock
      // will derive from the block we are about to build — same tip, same
      // stamp, same round — because the tip cannot move underneath a
      // synchronous call. A node that loses round 0 mints nothing and simply
      // keeps ticking; once its own clock has carried it a full
      // PROPOSER_SLOT_MS past the parent, the round moves on and this same call
      // may elect it.
      if (this.validators.length > 0) {
        const round = this.proposerRound(timestamp)
        const elected = selectValidator(this.validators, proposerSeed(this.tip, round))
        if (elected === null) return null
        if (elected.toLowerCase() !== publicKeyToHex(publicKey)) return null
      }

      const cap =
        opts && typeof opts.maxTransactions === "number" &&
        Number.isSafeInteger(opts.maxTransactions) && opts.maxTransactions > 0
          ? opts.maxTransactions
          : MAX_BLOCK_TRANSACTIONS
      // Filtered, not raw: selectForBlock walks the pool in the same order
      // take() does but on a working copy of the nonce and balance state, and
      // SKIPS an entry that would not stage. Without that one pending transfer
      // whose sender can no longer pay for it makes stage() answer null for the
      // whole block, at every tick, for ever — and the loop in
      // examples/run-node.ts reads that null as "nothing to do" and says
      // nothing. A skipped entry stays pending (see src/state/mempool.ts).
      const txs = this.mempool.selectForBlock(cap)
      if (txs.length === 0 && !(opts && opts.allowEmpty === true)) return null

      // Throws for an unencodable or unsigned transaction; a pooled transaction
      // is neither, but a proposer must not die on one.
      const blk = createBlock(blockHash(this.tip), this.tip.height + 1, txs, timestamp)

      const header: CanonicalBlockHeader = {
        parentHash: blk.parentHash,
        height: blk.height,
        timestamp: blk.timestamp,
        merkleRoot: blk.merkleRoot,
        proposerPublicKey: publicKey,
      }
      const signature = sign(canonicalBlockEncoding(header), secretKey)

      // Our own rules, on our own block, before anyone else sees it.
      if (!this.acceptBlock(blk, signature, publicKey)) return null

      this.broadcastBlock(blk, signature, publicKey)
      return blk
    } catch (e) {
      return null
    }
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
