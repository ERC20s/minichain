import { createHash } from "crypto"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding, canonicalEncoding } from "./coding/serialize"
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

/**
 * The bytes hashed as Merkle leaves: the SAME canonical transaction encoding
 * that ed25519 transaction signatures are made over.
 *
 * JSON.stringify used to produce these bytes, and it is not a canonical form:
 *
 *  - it preserves key insertion order, so one logical transaction has two leaf
 *    identities and therefore two Merkle roots;
 *  - it emits null for NaN and Infinity, so a block could commit to
 *    amount: NaN and every node would recompute the same root and accept it;
 *  - it validates nothing and copies unknown fields through verbatim.
 *
 * canonicalEncoding is injective and REJECTS what it cannot represent, so a
 * transaction that is not encodable never reaches the tree at all. A throw here
 * is the caller's signal to refuse the block, never to fall back to raw JSON.
 */
export function transactionLeaves(transactions: Transaction[]): Uint8Array[] {
  return (transactions || []).map((tx) => canonicalEncoding(tx))
}

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
