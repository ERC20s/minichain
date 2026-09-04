import { Transaction } from "../types/transaction"

/**
 * Per-sender nonce state: the only thing on this chain that makes a signed
 * transaction FRESH as well as authorised.
 *
 * An ed25519 transaction signature (src/tx.ts) proves that the account named by
 * `sender` consented to exactly these bytes. It says nothing about WHEN, and the
 * bytes never change, so until this module existed a proposer could take Alice's
 * accepted transaction and put the identical object in the next block — or twice
 * in one block — and every check in src/node.ts still passed: the leaves rebuild
 * the same Merkle root, verifyTransaction returns true for each copy (it is the
 * same preimage), the header signature and the stake-weighted proposer check are
 * untouched. The tip moved and the node re-broadcast the replay.
 *
 * The `nonce` field was already signed and canonically encoded (u64be(tx.nonce),
 * src/coding/serialize.ts) — nothing read it. This ledger reads it.
 *
 * The rule, in one line:
 *
 *   a transaction is accepted only if its nonce is STRICTLY GREATER than the
 *   last nonce accepted for its sender, counting transactions earlier in the
 *   same block.
 *
 * Strictly increasing, not exactly last + 1. There is no mempool and no account
 * state here, so a node cannot tell a gap ("Alice's nonce 2 was dropped") from a
 * forgery, and a sequential rule would wrongly stall honest traffic for ever
 * after a single missing transaction. Monotonicity is what kills a replay; the
 * gap-free rule is a later cycle, once there is state to reason about.
 *
 * Two consequences a proposer must live with:
 *  - one sender's transactions must appear in a block in ascending nonce order,
 *    because staging walks the list in order;
 *  - a sender can never reuse a nonce, so a transaction dropped from a rejected
 *    block must be re-signed with a nonce above whatever did land.
 *
 * All-or-nothing: stage() answers null for a whole block on the FIRST offending
 * transaction, and the caller drops the block. Nothing is written until commit()
 * — the node calls it only at the accept point, so a block rejected by a later
 * check (header signature, proposer election) cannot poison the ledger and lock
 * a sender out of nonces it never actually spent.
 *
 * In memory only, rebuilt from the genesis block a Node is constructed with. A
 * node started from a mid-chain snapshot has no history to compare against and
 * will accept a replay of anything older than its own start — persistence, and
 * a chain that can be replayed on startup, are separate work.
 */

/** The staged result of one block: sender hex -> highest nonce in that block. */
export type StagedNonces = Map<string, number>

/** A nonce this ledger can compare: a non-negative safe integer, as encoded. */
function isUsableNonce(nonce: unknown): nonce is number {
  return (
    typeof nonce === "number" &&
    Number.isInteger(nonce) &&
    nonce >= 0 &&
    nonce <= Number.MAX_SAFE_INTEGER
  )
}

/** A sender this ledger can key on: a non-empty string, as signed. */
function isUsableSender(sender: unknown): sender is string {
  return typeof sender === "string" && sender.length > 0
}

export class NonceLedger {
  /** sender hex -> the last nonce accepted for it. */
  private last: Map<string, number>

  /**
   * `genesisTransactions` seeds the ledger with the highest nonce per sender
   * already on the chain, so a transaction sitting in genesis cannot be replayed
   * into block 1. Seeding is LENIENT — a genesis block is a local, out-of-band
   * fixture and nothing verifies it — so an entry it cannot read is skipped
   * rather than thrown over.
   */
  constructor(genesisTransactions: Transaction[] = []) {
    this.last = new Map()
    for (const tx of genesisTransactions || []) {
      if (!tx || typeof tx !== "object") continue
      if (!isUsableSender(tx.sender) || !isUsableNonce(tx.nonce)) continue
      const known = this.last.get(tx.sender)
      if (known === undefined || tx.nonce > known) this.last.set(tx.sender, tx.nonce)
    }
  }

  /** The last nonce accepted for `sender`, or undefined if it has spent none. */
  lastNonce(sender: string): number | undefined {
    return this.last.get(sender)
  }

  /** How many senders this ledger has seen. Used by tests. */
  get size(): number {
    return this.last.size
  }

  /**
   * Check a whole block's transactions against the committed state WITHOUT
   * writing anything.
   *
   * Returns the staged map to hand to commit() when every transaction moves its
   * sender's nonce strictly forward, and null the moment one does not — a
   * replay of an older block, a repeat of the same transaction inside this
   * block, an out-of-order pair from one sender, or a nonce/sender shape the
   * ledger cannot compare.
   *
   * An empty list stages cleanly, as it always did.
   */
  stage(transactions: Transaction[]): StagedNonces | null {
    const staged: StagedNonces = new Map()
    for (const tx of transactions || []) {
      if (!tx || typeof tx !== "object") return null
      if (!isUsableSender(tx.sender) || !isUsableNonce(tx.nonce)) return null
      // within one block, a sender's later transaction is compared against its
      // earlier one, so the same transaction twice is caught here.
      const seen = staged.has(tx.sender)
        ? (staged.get(tx.sender) as number)
        : this.last.get(tx.sender)
      if (seen !== undefined && tx.nonce <= seen) return null
      staged.set(tx.sender, tx.nonce)
    }
    return staged
  }

  /**
   * Write a staged map. Called only once the block is accepted — after every
   * other check in the "blk" handler, next to the tip move.
   *
   * Writes are max(), never a blind overwrite, so committing a stale map can
   * only be a no-op and never walks a sender's nonce backwards.
   */
  commit(staged: StagedNonces | null): void {
    if (!staged) return
    staged.forEach((nonce, sender) => {
      const known = this.last.get(sender)
      if (known === undefined || nonce > known) this.last.set(sender, nonce)
    })
  }
}
