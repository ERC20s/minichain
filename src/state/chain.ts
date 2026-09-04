import { Block } from "../block"

/**
 * The blocks this node has accepted, so it can answer a peer that fell behind.
 *
 * Until this module existed a Node kept exactly ONE block — `this.tip` — and
 * acceptBlock refuses anything that is not the very next one:
 *
 *   if (blk.height !== this.tip.height + 1) return false
 *   if (blk.parentHash !== blockHash(this.tip)) return false
 *
 * So a node that started after the proposer minted anything, or that dropped a
 * single "blk" frame, silently stopped following: every later block was a FUTURE
 * block, it was dropped, and no node on the mesh could have answered a request
 * for the gap even if one had been asked — nobody kept a block once the tip had
 * moved past it. This store is what makes an answer possible.
 *
 * What a stored entry holds is a SEALED block: the block itself together with
 * the header signature and the proposer public key it arrived with. Those two
 * are not part of the Block object (a Uint8Array does not survive
 * JSON.stringify, and the header signature is made over the canonical header,
 * not over the block's JSON), yet a peer cannot judge a block without them —
 * acceptBlock refuses a block with no sig or pubKey. Serving a block without its
 * seal would be serving something no honest node can accept.
 *
 * Two bounds, both hard:
 *
 *  - CAPACITY. At most `capacity` heights are held (DEFAULT_CHAIN_STORE_CAPACITY
 *    = 1024). Putting a block above the ceiling evicts the LOWEST height held,
 *    so memory is bounded no matter how long a node runs. A node that has been
 *    up for a week cannot serve the whole chain; it serves its recent window,
 *    which is what a peer a few blocks behind needs.
 *  - CONSECUTIVENESS. range() only ever returns blocks that follow each other
 *    without a gap, starting at exactly the height asked for. A follower applies
 *    them through acceptBlock in order, and acceptBlock demands
 *    height = tip.height + 1, so a batch with a hole in it would stall at the
 *    hole anyway; refusing to send one keeps the wire honest about it.
 *
 * Genesis is deliberately NOT held here. It is the one block nothing signs and
 * nothing judges — every node builds it for itself with createGenesisBlock()
 * (src/block.ts) — so there is no seal to serve and no version of it a peer
 * should take from another node. Only blocks that PASSED acceptBlock are put in.
 *
 * In memory only, like every other ledger in this project. A restarted node
 * starts with an empty store and refills it as blocks arrive; persistence is
 * separate work.
 */

/** A block together with the header signature and proposer key it travelled with. */
export interface SealedBlock {
  block: Block
  sig: Uint8Array
  pubKey: Uint8Array
}

/** How many heights a store holds before the lowest one is evicted. */
export const DEFAULT_CHAIN_STORE_CAPACITY = 1024

/** A height this store can key on: a non-negative safe integer, as encoded. */
function isUsableHeight(height: unknown): height is number {
  return typeof height === "number" && Number.isSafeInteger(height) && height >= 0
}

export class ChainStore {
  /** height -> the sealed block accepted at that height. */
  private byHeight: Map<number, SealedBlock>
  /** The most heights this store keeps. Always a positive safe integer. */
  readonly capacity: number

  constructor(capacity: number = DEFAULT_CHAIN_STORE_CAPACITY) {
    this.byHeight = new Map()
    this.capacity =
      typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0
        ? capacity
        : DEFAULT_CHAIN_STORE_CAPACITY
  }

  /** How many heights are held right now. */
  get size(): number {
    return this.byHeight.size
  }

  /** The lowest height held, or undefined when the store is empty. */
  get lowestHeight(): number | undefined {
    let lowest: number | undefined
    this.byHeight.forEach((_entry, height) => {
      if (lowest === undefined || height < lowest) lowest = height
    })
    return lowest
  }

  /** The highest height held, or undefined when the store is empty. */
  get highestHeight(): number | undefined {
    let highest: number | undefined
    this.byHeight.forEach((_entry, height) => {
      if (highest === undefined || height > highest) highest = height
    })
    return highest
  }

  /**
   * Record an ACCEPTED block with the seal it arrived under.
   *
   * The caller is src/node.ts at the accept point, beside nonces.commit and
   * balances.commit, so a self-minted block and a gossiped one are stored by the
   * same line. Nothing here re-judges the block: by the time this runs every
   * rule has passed. It only refuses what it cannot key or cannot serve — a
   * block with an unusable height, or one with no signature or public key, since
   * a peer could never accept such an entry.
   *
   * A height already held is OVERWRITTEN by the newer seal, which for this chain
   * is a no-op: the tip only ever moves forward, so a height is written once.
   *
   * Returns true when the block was stored.
   */
  put(block: Block, sig?: Uint8Array, pubKey?: Uint8Array): boolean {
    if (!block || typeof block !== "object") return false
    if (!isUsableHeight(block.height)) return false
    if (!(sig instanceof Uint8Array) || sig.length === 0) return false
    if (!(pubKey instanceof Uint8Array) || pubKey.length === 0) return false

    this.byHeight.set(block.height, { block, sig, pubKey })
    this.prune()
    return true
  }

  /** The sealed block at `height`, or undefined. */
  get(height: number): SealedBlock | undefined {
    if (!isUsableHeight(height)) return undefined
    return this.byHeight.get(height)
  }

  /** Whether this store can serve `height`. */
  has(height: number): boolean {
    return this.get(height) !== undefined
  }

  /**
   * Up to `max` CONSECUTIVE sealed blocks starting at exactly `from`.
   *
   * Returns an empty array when `from` is not held — a node asks for
   * tip.height + 1 and a store whose window starts above that simply cannot help
   * (the asker must be given the chain from an older peer or restart) — and
   * stops at the first missing height rather than sending a batch with a hole
   * the receiver would stall on anyway.
   *
   * `max` is clamped to a sane positive integer by the caller; a non-integer or
   * non-positive value here yields nothing at all rather than an unbounded walk.
   */
  range(from: number, max: number): SealedBlock[] {
    const out: SealedBlock[] = []
    if (!isUsableHeight(from)) return out
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) return out

    for (let height = from; height < from + max; height++) {
      const entry = this.byHeight.get(height)
      if (entry === undefined) break
      out.push(entry)
    }
    return out
  }

  /** Drop the lowest heights until the store is inside its capacity. */
  private prune(): void {
    while (this.byHeight.size > this.capacity) {
      const lowest = this.lowestHeight
      if (lowest === undefined) return
      this.byHeight.delete(lowest)
    }
  }
}
