import { merkleRoot } from "./merkle"
import { canonicalEncoding } from "./coding/serialize"
import { Transaction } from "./types/transaction"

export interface Block {
  parentHash: string
  height: number
  timestamp: number
  transactions: Transaction[]
  merkleRoot: string
}

/**
 * The single source of Merkle leaf bytes for a block.
 *
 * Leaves are sha256(canonicalEncoding(tx)) — the very same bytes a transaction
 * signature covers (see src/coding/serialize.ts). Using JSON.stringify here
 * would make the root depend on key insertion order, drop `undefined` fields
 * and print large numbers in exponent form, so two honest nodes holding the
 * same logical transaction could compute different roots and silently drop
 * each other's blocks.
 *
 * Both the block builder (createBlock) and the block validator (src/node.ts)
 * must go through this function.
 */
export function blockMerkleRoot(transactions: Transaction[]): string {
  const txBytes = (transactions || []).map((tx) => canonicalEncoding(tx))
  return merkleRoot(txBytes)
}

export function createBlock(parentHash: string, height: number, transactions: Transaction[]): Block {
  return {
    parentHash,
    height,
    timestamp: Date.now(),
    transactions,
    merkleRoot: blockMerkleRoot(transactions),
  }
}
