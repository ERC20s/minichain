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
 */
export function createBlock(parentHash: string, height: number, transactions: Transaction[]): Block {
  const txBytes = transactionLeaves(transactions)
  return {
    parentHash,
    height,
    timestamp: Date.now(),
    transactions,
    merkleRoot: merkleRoot(txBytes),
  }
}
