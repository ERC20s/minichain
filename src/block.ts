import { createHash } from "crypto"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, canonicalEncoding } from "./coding/serialize"
import { transactionSignatureBytes } from "./tx"
import { Transaction } from "./types/transaction"

export interface Block {
  parentHash: string
  height: number
  timestamp: number
  transactions: Transaction[]
  merkleRoot: string
}

/** Domain separator for the block hash, so a block hash preimage can never be
 *  mistaken for a signing preimage or a Merkle leaf. */
export const BLOCK_HASH_PREFIX = "blkhash:"

/**
 * The identity of a block: hex sha256 over a domain-separated, canonical
 * encoding of its HEADER.
 *
 *   sha256("blkhash:" || canonicalBlockEncoding({parentHash, height, timestamp, merkleRoot}))
 *
 * The Merkle root commits to the transactions and to nothing else, so it cannot
 * serve as a link between blocks: two blocks with the same transaction list —
 * different height, different timestamp — share a merkleRoot, and every empty
 * block shares one (merkleRoot([]) is sha256 of no input). Hashing the whole
 * header instead makes each block's link unique to that block, so a parent's
 * timestamp or height cannot be swapped without breaking every descendant.
 *
 * The encoder from src/coding/serialize.ts is reused rather than a second
 * format, so the same validation applies: a header with a missing or mistyped
 * field throws a CanonicalEncodingError instead of hashing "undefined".
 * proposerPublicKey is deliberately left absent (encoded as a zero length):
 * Block carries no proposer field and a Uint8Array does not survive
 * JSON.stringify, so including it would make the hash depend on how the block
 * travelled.
 */
export function blockHash(block: Block): string {
  const header = canonicalBlockEncoding({
    parentHash: block.parentHash,
    height: block.height,
    timestamp: block.timestamp,
    merkleRoot: block.merkleRoot,
  })
  const prefix = new TextEncoder().encode(BLOCK_HASH_PREFIX)
  const preimage = new Uint8Array(prefix.length + header.length)
  preimage.set(prefix, 0)
  preimage.set(header, prefix.length)
  return createHash("sha256").update(Buffer.from(preimage)).digest("hex")
}

/** Domain separator for a signed-transaction Merkle leaf. */
export const SIGNED_TX_LEAF_PREFIX = "stx:"

/**
 * One Merkle leaf:
 *
 *   "stx:" || uint16be(len(signature)) || signature || canonicalEncoding(tx)
 *
 * The body is the SAME canonical transaction encoding an ed25519 transaction
 * signature is made over (JSON.stringify is not a canonical form: it preserves
 * key insertion order, emits null for NaN and Infinity, and copies unknown
 * fields through untouched), and canonicalEncoding REJECTS what it cannot
 * represent, so an unencodable transaction never reaches the tree.
 *
 * The 64 signature bytes are hashed INTO the leaf, in front of the body and
 * behind their own length, because the signature is excluded from the signing
 * preimage: without this a relay could strip a signature, or swap in another
 * account's, and the recomputed root — and therefore the block hash and the
 * proposer's header signature — would still match. The "stx:" tag keeps this
 * preimage distinct from a bare "tx:" signing preimage and from the "blkhash:"
 * block preimage.
 *
 * An unsigned or malformed transaction throws (TransactionSignatureError). A
 * throw here is the caller's signal to refuse the block, never a fallback.
 */
export function transactionLeaf(tx: Transaction): Uint8Array {
  const signature = transactionSignatureBytes(tx)
  const body = canonicalEncoding(tx)
  const prefix = new TextEncoder().encode(SIGNED_TX_LEAF_PREFIX)
  const out = new Uint8Array(prefix.length + 2 + signature.length + body.length)
  let off = 0
  out.set(prefix, off)
  off += prefix.length
  out[off++] = (signature.length >> 8) & 0xff
  out[off++] = signature.length & 0xff
  out.set(signature, off)
  off += signature.length
  out.set(body, off)
  return out
}

/** The bytes hashed as Merkle leaves, one per transaction. */
export function transactionLeaves(transactions: Transaction[]): Uint8Array[] {
  return (transactions || []).map((tx) => transactionLeaf(tx))
}

/**
 * Assemble a block. Every transaction must already be signed: an unsigned or
 * malformed one throws rather than being committed to, so a node cannot produce
 * a block its own peers are required to drop.
 *
 * `timestamp` is optional. Left out, the block is stamped with Date.now(), which
 * is what genesis and the tests have always wanted. A proposer passes it: a Node
 * carries an INJECTABLE clock (NodeOptions.now, src/node.ts) and judges an
 * incoming stamp against that clock and against its parent's stamp, so a block
 * this node mints has to be stamped from the same clock — otherwise a test that
 * moves `now` would mint blocks its own node refuses. Anything that is not a
 * non-negative safe integer falls back to Date.now() rather than putting NaN or
 * a fraction into a header the block hash covers.
 */
export function createBlock(
  parentHash: string,
  height: number,
  transactions: Transaction[],
  timestamp?: number
): Block {
  const txBytes = transactionLeaves(transactions)
  const stamped =
    typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0
      ? timestamp
      : Date.now()
  return {
    parentHash,
    height,
    timestamp: stamped,
    transactions,
    merkleRoot: merkleRoot(txBytes),
  }
}

/**
 * The parentHash of block 0. Genesis has no parent, so this string is a fixed
 * placeholder rather than a hash of anything: nothing verifies it, but every
 * node must agree on it, because it is part of the preimage of the genesis
 * BLOCK HASH that block 1 has to name.
 */
export const GENESIS_PARENT_HASH = "genesis"

/**
 * The timestamp of block 0: the epoch, not "now".
 *
 * Genesis is the one block no proposer mints and no peer judges — it is the
 * agreed starting point every node is constructed with — so it must not depend
 * on WHEN a node was started. Zero is a non-negative safe integer, so it passes
 * acceptBlock's timestamp rule as a parent stamp, and every later block (stamped
 * from a real clock) is trivially not behind it.
 */
export const GENESIS_TIMESTAMP = 0

/**
 * The genesis block — the same bytes, and therefore the same blockHash, in every
 * process, on every box, at any time.
 *
 * Why this exists: createBlock stamps Date.now() when no timestamp is passed and
 * blockHash covers the timestamp, so `createBlock("genesis", 0, [])` gave two
 * nodes started a millisecond apart two DIFFERENT genesis hashes. Neither could
 * ever accept the other's block 1: acceptBlock requires
 * `blk.parentHash === blockHash(this.tip)`, that comparison failed silently, and
 * the follower sat at height 0 for ever. The whole gossip, proof-of-stake and
 * mempool stack could not form a two-node network.
 *
 * This is a pure function of its argument. Two calls in two processes, with the
 * same transactions, produce byte-identical blocks. `transactions` is the opening
 * state: NonceLedger and BalanceLedger seed from the genesis block a Node is
 * constructed with (genesis mints; it debits nobody), and nodes in one network
 * must be constructed with the same list — a different list is a different
 * merkleRoot and therefore, again, a different chain.
 */
export function createGenesisBlock(transactions: Transaction[] = []): Block {
  return createBlock(GENESIS_PARENT_HASH, 0, transactions, GENESIS_TIMESTAMP)
}
