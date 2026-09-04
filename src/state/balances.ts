import { Transaction } from "../types/transaction"

/**
 * Per-account balance state: the only thing on this chain that makes a signed,
 * fresh transaction AFFORDABLE.
 *
 * An ed25519 transaction signature (src/tx.ts) proves the account named by
 * `sender` consented to exactly these bytes, and the nonce ledger
 * (src/state/nonces.ts) proves the transaction has not been seen before. Neither
 * says the sender HAS the money. Until this module existed, an elected proposer
 * could sign {sender: <its own key>, recipient: "me", amount: 1e15, nonce: 1}
 * from an account that had never received a coin and every check in src/node.ts
 * passed: the leaves rebuild the same Merkle root, verifyTransaction returns
 * true, the nonce rises, the header signature and the stake-weighted proposer
 * check are untouched. The tip moved, the node relayed it, and value was created
 * out of nothing.
 *
 * The rule, in one line:
 *
 *   a transaction is accepted only if its sender's running balance is at least
 *   its amount, counting transactions earlier in the same block.
 *
 * Where balances come from. There are no fees, no block reward and no mint
 * transaction on this chain, so a closed system starting from zero could never
 * move a coin. Two seeds open it:
 *
 *  - genesis transactions MINT: a transaction in the genesis block credits its
 *    recipient and debits nobody. Genesis is a local, out-of-band fixture that
 *    nothing verifies, so this is bookkeeping, not a security decision — every
 *    node in a network must be constructed with the SAME genesis block or their
 *    ledgers disagree and the network forks at the first transfer.
 *  - an optional opening-balance map handed to the constructor, for a node whose
 *    funding is configured rather than written into genesis.
 *
 * All-or-nothing, exactly like the nonce ledger: stage() answers null for the
 * WHOLE block on the first transaction its sender cannot afford, and the caller
 * drops the block. Nothing is written until commit(), which the node calls only
 * at the accept point, so a block dropped by a later check (header signature,
 * proposer election) cannot spend balances the chain never spent.
 *
 * A staged batch also carries the ledger revision it was computed against.
 * Balance writes are absolute (a balance is a value, not a high-water mark like
 * a nonce), so committing a stale batch would silently rewrite state that has
 * moved on; commit() refuses a batch whose revision no longer matches.
 *
 * In memory only, rebuilt from the genesis block a Node is constructed with. A
 * node started from a mid-chain snapshot has no history: it sees the opening
 * balances it was given and nothing else. Fees, gap-free nonces and persistence
 * remain later work.
 */

/** The staged effect of one block: account hex -> its balance after the block. */
export interface StagedBalances {
  /** The ledger revision this batch was staged against. */
  readonly revision: number
  /** account -> new balance, for the accounts this block touches. */
  readonly changes: Map<string, number>
}

/** Opening balances a Node may be constructed with. */
export type OpeningBalances =
  | Record<string, number>
  | Map<string, number>
  | Array<[string, number]>

/** An amount this ledger can add or subtract: a non-negative safe integer. */
function isUsableAmount(amount: unknown): amount is number {
  return (
    typeof amount === "number" &&
    Number.isInteger(amount) &&
    amount >= 0 &&
    amount <= Number.MAX_SAFE_INTEGER
  )
}

/** An account this ledger can key on: a non-empty string, as signed. */
function isUsableAccount(account: unknown): account is string {
  return typeof account === "string" && account.length > 0
}

/** Normalise the three accepted shapes of an opening-balance map. */
function openingEntries(opening?: OpeningBalances): Array<[string, number]> {
  if (!opening) return []
  if (opening instanceof Map) return Array.from(opening.entries())
  if (Array.isArray(opening)) return opening.map((e) => [e[0], e[1]] as [string, number])
  return Object.keys(opening).map((k) => [k, opening[k]] as [string, number])
}

export class BalanceLedger {
  /** account hex -> committed balance. Absent means zero. */
  private balances: Map<string, number>
  /** Bumped on every commit, so a stale staged batch can be recognised. */
  private revision: number

  /**
   * `opening` credits accounts before genesis is read; `genesisTransactions`
   * then MINT, crediting each recipient without debiting the sender.
   *
   * Seeding is LENIENT — a genesis block is a local fixture and nothing verifies
   * it — so an entry this ledger cannot read is skipped rather than thrown over.
   * A credit that would pass MAX_SAFE_INTEGER is clamped to it, because a seed
   * is not a transfer anybody signed.
   */
  constructor(genesisTransactions: Transaction[] = [], opening?: OpeningBalances) {
    this.balances = new Map()
    this.revision = 0

    for (const [account, amount] of openingEntries(opening)) {
      if (!isUsableAccount(account) || !isUsableAmount(amount)) continue
      this.credit(account, amount)
    }

    for (const tx of genesisTransactions || []) {
      if (!tx || typeof tx !== "object") continue
      if (!isUsableAccount(tx.recipient) || !isUsableAmount(tx.amount)) continue
      this.credit(tx.recipient, tx.amount)
    }
  }

  private credit(account: string, amount: number): void {
    const held = this.balances.get(account) || 0
    const sum = held + amount
    this.balances.set(account, sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum)
  }

  /** The committed balance of `account`; an account never credited holds 0. */
  balanceOf(account: string): number {
    if (!isUsableAccount(account)) return 0
    return this.balances.get(account) || 0
  }

  /** How many accounts this ledger has seen. Used by tests. */
  get size(): number {
    return this.balances.size
  }

  /**
   * Check a whole block's transactions against the committed state WITHOUT
   * writing anything.
   *
   * Walks the list in order on a working copy: debit the sender, credit the
   * recipient, and answer null the moment one transaction cannot be applied —
   *
   *  - a sender whose running balance is short of `amount` (an overdraft, and
   *    equally a double spend split across two transactions in one block);
   *  - an `amount`, `sender` or `recipient` the ledger cannot read;
   *  - a credit that would carry an account past MAX_SAFE_INTEGER, where
   *    JavaScript addition stops being exact.
   *
   * A self-transfer (sender === recipient) is a no-op the sender must still be
   * able to afford, because the debit is applied before the credit.
   *
   * An empty list stages cleanly, as it always did.
   */
  stage(transactions: Transaction[]): StagedBalances | null {
    const changes = new Map<string, number>()
    const current = (account: string): number =>
      changes.has(account) ? (changes.get(account) as number) : this.balanceOf(account)

    for (const tx of transactions || []) {
      if (!tx || typeof tx !== "object") return null
      if (!isUsableAccount(tx.sender) || !isUsableAccount(tx.recipient)) return null
      if (!isUsableAmount(tx.amount)) return null

      const held = current(tx.sender)
      if (held < tx.amount) return null
      changes.set(tx.sender, held - tx.amount)

      // read again: a self-transfer must see the debit it just made
      const credited = current(tx.recipient) + tx.amount
      if (credited > Number.MAX_SAFE_INTEGER) return null
      changes.set(tx.recipient, credited)
    }

    return { revision: this.revision, changes }
  }

  /**
   * Write a staged batch. Called only once the block is accepted — after every
   * other check in the "blk" handler, next to the tip move and the nonce commit,
   * so tip, nonces and balances can never disagree.
   *
   * A null batch, or one staged against an earlier revision of this ledger, is
   * ignored: balance writes are absolute, so replaying a stale batch would undo
   * whatever landed in between.
   */
  commit(staged: StagedBalances | null): void {
    if (!staged || !staged.changes) return
    if (staged.revision !== this.revision) return
    staged.changes.forEach((balance, account) => {
      this.balances.set(account, balance)
    })
    this.revision += 1
  }
}
