import { createHash } from "crypto"
import { transactionLeaf } from "../block"
import { verifyTransaction } from "../tx"
import { Transaction } from "../types/transaction"

/**
 * The pending-transaction pool: what a node does with a transaction that is not
 * inside a block yet.
 *
 * Twelve cycles hardened what a node ACCEPTS — linkage, timestamps, the Merkle
 * root, per-transaction signatures, nonces, balances, the header signature and
 * the elected proposer. None of that applies to a LOOSE transaction. The gossip
 * transport has always spoken the frame (ALLOWED_TYPES = {"tx", "blk"} in
 * src/gossip/ws.ts) and src/node.ts registered a listener for "blk" only, so a
 * gossiped "tx" was validated as an envelope, emitted, and fell on the floor: no
 * pool, no relay, nowhere for a user of `npm run dev` to put a transfer.
 *
 * This module is that missing place. It is NOT a second consensus path: nothing
 * here moves the tip, writes a ledger or accepts a block. It holds transactions
 * that WOULD pass the block rules if a proposer picked them up, and it applies
 * exactly the same three rules to decide that:
 *
 *  - AUTHORISED: verifyTransaction(tx) (src/tx.ts) — an ed25519 signature that
 *    verifies against the public key the transaction's own `sender` names.
 *  - FRESH: the nonce must be strictly greater than the last nonce the node has
 *    accepted for that sender (NonceLedger.lastNonce), and no transaction
 *    already pending from that sender may hold the same nonce — only one of two
 *    same-nonce transactions can ever land.
 *  - AFFORDABLE: the sender's committed balance (BalanceLedger.balanceOf) must
 *    cover this amount TOGETHER WITH everything that sender already has pending,
 *    so a sender cannot queue two transfers it can only pay for one at a time.
 *
 * Identity. A pooled transaction is keyed by
 *
 *   id = sha256(transactionLeaf(tx))   (hex)
 *
 * — the same Merkle leaf a block commits to, so the id covers BOTH the canonical
 * body and the signature bytes. Two spellings of one transfer are one entry, and
 * a re-signed or edited copy is a different entry, exactly as the tree sees it.
 *
 * Bounded, always. A pool that grows with whatever peers send is a memory
 * exhaustion bug with extra steps, so MAX_MEMPOOL caps the whole pool and
 * MAX_MEMPOOL_PER_SENDER caps one account's share of it; past either cap a
 * transaction is REFUSED (never evicting something already admitted, which would
 * let a flooder push out honest traffic).
 *
 * Relay once. add() reports whether THIS node admitted the transaction for the
 * first time. src/node.ts re-broadcasts only on that answer, so a transaction
 * that is already pending, or that fails a rule, is not relayed and the gossip
 * mesh cannot loop a transaction between two peers for ever.
 *
 * In memory only. A pending transaction is lost on restart and two nodes can
 * legitimately hold different pools — a mempool is local policy, not consensus.
 * Persistence, fee-based ordering and eviction are later work.
 */

/** Largest number of transactions the pool holds at once. */
export const MAX_MEMPOOL = 1024

/** Largest number of pending transactions one sender may hold. */
export const MAX_MEMPOOL_PER_SENDER = 64

/** Why add() answered as it did. "admitted" is the only accepting answer. */
export type MempoolReason =
  | "admitted"
  | "malformed"
  | "unauthorised"
  | "duplicate"
  | "replayed"
  | "unaffordable"
  | "pool-full"
  | "sender-full"

/** The answer add() gives. `admitted` is true only on FIRST admission. */
export interface MempoolResult {
  readonly admitted: boolean
  /** The transaction id, when it could be computed; null otherwise. */
  readonly id: string | null
  readonly reason: MempoolReason
}

/** One pooled transaction, with the fields the pool sorts and counts on. */
export interface MempoolEntry {
  readonly id: string
  readonly tx: Transaction
  readonly sender: string
  readonly nonce: number
  readonly amount: number
  /** Admission order, used only to break ties deterministically. */
  readonly sequence: number
}

/** What the pool needs of the nonce ledger (src/state/nonces.ts). */
export interface NonceView {
  lastNonce(sender: string): number | undefined
}

/** What the pool needs of the balance ledger (src/state/balances.ts). */
export interface BalanceView {
  balanceOf(account: string): number
}

/** Optional caps, mainly so a test can fill a small pool. */
export interface MempoolOptions {
  /** Overrides MAX_MEMPOOL. Must be a positive safe integer. */
  maxSize?: number
  /** Overrides MAX_MEMPOOL_PER_SENDER. Must be a positive safe integer. */
  maxPerSender?: number
}

/** A value the pool can compare: a non-negative safe integer, as encoded. */
function isUsableNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
}

function positiveCap(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * The identity of a transaction: hex sha256 of its Merkle leaf.
 *
 * transactionLeaf (src/block.ts) is "stx:" || uint16be(len(sig)) || sig ||
 * canonicalEncoding(tx), so the id covers the signature as well as the canonical
 * body and is domain-separated from every other preimage on this chain. Throws
 * (TransactionSignatureError, CanonicalEncodingError) for an unsigned or
 * unencodable transaction — callers treat a throw as "not poolable".
 */
export function transactionId(tx: Transaction): string {
  return createHash("sha256").update(Buffer.from(transactionLeaf(tx))).digest("hex")
}

export class Mempool {
  private readonly nonces: NonceView
  private readonly balances: BalanceView
  /** id -> entry, in admission order (a Map keeps insertion order). */
  private readonly entries: Map<string, MempoolEntry>
  /** sender -> the ids it has pending, so the caps and sums are O(1)-ish. */
  private readonly bySender: Map<string, Set<string>>
  private sequence: number

  readonly maxSize: number
  readonly maxPerSender: number

  /**
   * The pool reads the node's own ledgers; it never writes them. The node owns
   * both, so a transaction admitted here is judged against exactly the state the
   * "blk" handler would judge it against.
   */
  constructor(nonces: NonceView, balances: BalanceView, options?: MempoolOptions) {
    this.nonces = nonces
    this.balances = balances
    this.entries = new Map()
    this.bySender = new Map()
    this.sequence = 0
    this.maxSize = positiveCap(options && options.maxSize, MAX_MEMPOOL)
    this.maxPerSender = positiveCap(options && options.maxPerSender, MAX_MEMPOOL_PER_SENDER)
  }

  /** How many transactions are pending. */
  get size(): number {
    return this.entries.size
  }

  /** Is this transaction id pending? */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** The pending transaction ids, in admission order. */
  ids(): string[] {
    return Array.from(this.entries.keys())
  }

  /** The pending transaction with this id, if any. */
  get(id: string): Transaction | undefined {
    const entry = this.entries.get(id)
    return entry ? entry.tx : undefined
  }

  /** A sender's pending transactions, in ascending nonce order. */
  pendingFor(sender: string): Transaction[] {
    return this.entriesFor(sender)
      .sort((a, b) => a.nonce - b.nonce || a.sequence - b.sequence)
      .map((entry) => entry.tx)
  }

  /** The total a sender has queued but not yet spent on the chain. */
  pendingAmount(sender: string): number {
    let total = 0
    for (const entry of this.entriesFor(sender)) total += entry.amount
    return total
  }

  private entriesFor(sender: string): MempoolEntry[] {
    const ids = this.bySender.get(sender)
    if (!ids) return []
    const out: MempoolEntry[] = []
    ids.forEach((id) => {
      const entry = this.entries.get(id)
      if (entry) out.push(entry)
    })
    return out
  }

  /**
   * Offer a transaction to the pool.
   *
   * Answers {admitted: true} ONLY the first time a transaction is accepted, so
   * the caller can relay exactly once. Every other answer — already pending,
   * unsigned, replayed, unaffordable, over a cap — is a drop: nothing is stored
   * and nothing should be re-broadcast.
   *
   * Never throws: a hostile peer's JSON is ordinary input here.
   */
  add(tx: Transaction): MempoolResult {
    if (!tx || typeof tx !== "object") return { admitted: false, id: null, reason: "malformed" }

    // Cheapest first: a full pool costs a size comparison, not a signature.
    if (this.entries.size >= this.maxSize) {
      return { admitted: false, id: null, reason: "pool-full" }
    }

    // Authorised. verifyTransaction answers false — never throws — for a
    // missing, malformed, unencodable or wrong-key signature.
    if (!verifyTransaction(tx)) {
      return { admitted: false, id: null, reason: "unauthorised" }
    }

    let id: string
    try {
      id = transactionId(tx)
    } catch (e) {
      // Unreachable while verifyTransaction has passed (it encodes the same
      // fields), but the pool must never depend on that to stay standing.
      return { admitted: false, id: null, reason: "malformed" }
    }

    if (this.entries.has(id)) return { admitted: false, id, reason: "duplicate" }

    const sender = tx.sender
    if (typeof sender !== "string" || sender.length === 0) {
      return { admitted: false, id, reason: "malformed" }
    }
    if (!isUsableNumber(tx.nonce) || !isUsableNumber(tx.amount)) {
      return { admitted: false, id, reason: "malformed" }
    }

    const pending = this.entriesFor(sender)
    if (pending.length >= this.maxPerSender) {
      return { admitted: false, id, reason: "sender-full" }
    }

    // Fresh: strictly above what the chain has accepted for this sender, and not
    // a second transaction at a nonce already queued (only one can ever land).
    const last = this.nonces.lastNonce(sender)
    if (last !== undefined && tx.nonce <= last) {
      return { admitted: false, id, reason: "replayed" }
    }
    for (const entry of pending) {
      if (entry.nonce === tx.nonce) return { admitted: false, id, reason: "replayed" }
    }

    // Affordable: the committed balance must cover this amount AND everything
    // this sender already has queued. Incoming pending credits are deliberately
    // not counted — money that has not landed cannot be spent.
    let queued = 0
    for (const entry of pending) queued += entry.amount
    if (this.balances.balanceOf(sender) - queued < tx.amount) {
      return { admitted: false, id, reason: "unaffordable" }
    }

    const entry: MempoolEntry = {
      id,
      tx,
      sender,
      nonce: tx.nonce,
      amount: tx.amount,
      sequence: this.sequence++,
    }
    this.entries.set(id, entry)
    const ids = this.bySender.get(sender) || new Set<string>()
    ids.add(id)
    this.bySender.set(sender, ids)
    return { admitted: true, id, reason: "admitted" }
  }

  /**
   * Up to `n` pending transactions for a future proposer, ordered so that a
   * block built from them stages cleanly: ascending nonce, ties broken by
   * admission order, which keeps every single sender's own transactions in
   * ascending nonce order (the duty src/state/nonces.ts puts on a proposer).
   *
   * Nothing is removed — a transaction leaves the pool only when a block
   * committing it is accepted (see drop()).
   */
  take(n: number): Transaction[] {
    if (!Number.isFinite(n) || n <= 0) return []
    return Array.from(this.entries.values())
      .sort((a, b) => a.nonce - b.nonce || a.sequence - b.sequence)
      .slice(0, Math.floor(n))
      .map((entry) => entry.tx)
  }

  /** Forget one id. Returns true if something was actually pending. */
  remove(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    const ids = this.bySender.get(entry.sender)
    if (ids) {
      ids.delete(id)
      if (ids.size === 0) this.bySender.delete(entry.sender)
    }
    return true
  }

  /**
   * A block was accepted: forget what it committed, and everything it made
   * stale.
   *
   * Called from src/node.ts beside the nonce and balance commits, so the ledgers
   * it reads are already at the new tip. Two things go:
   *
   *  - every transaction the block carried, by id;
   *  - every remaining pending transaction whose nonce is no longer strictly
   *    above its sender's committed nonce — a transaction that can never be
   *    included now, whether or not it is the one that landed.
   *
   * Returns how many entries were removed.
   */
  drop(transactions: Transaction[]): number {
    let removed = 0
    for (const tx of transactions || []) {
      if (!tx || typeof tx !== "object") continue
      let id: string
      try {
        id = transactionId(tx)
      } catch (e) {
        continue
      }
      if (this.remove(id)) removed += 1
    }

    for (const entry of Array.from(this.entries.values())) {
      const last = this.nonces.lastNonce(entry.sender)
      if (last !== undefined && entry.nonce <= last) {
        if (this.remove(entry.id)) removed += 1
      }
    }
    return removed
  }

  /** Empty the pool. */
  clear(): void {
    this.entries.clear()
    this.bySender.clear()
    this.sequence = 0
  }
}
