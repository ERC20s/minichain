import { createHash } from "crypto"
import { merkleRoot } from "./merkle"
import { canonicalBlockEncoding } from "./coding/serialize"
import { Transaction } from "./types/transaction"

export interface Block {
  parentHash: string
  height: number
  timestamp: number
  transactions: Transaction[]
  merkleRoot: string
}

/**
 * The subset of a block that block identity commits to.
 * Note: proposerPublicKey is deliberately NOT part of the block hash (blockHash v1),
 * so any peer can compute a block's hash from the block alone, without the
 * gossip envelope that carries the proposer key and signature.
 */
export type BlockHashInput = {
  parentHash: string
  height: number
  timestamp: number
  merkleRoot: string
}

/**
 * blockHash v1: hex sha256 over canonicalBlockEncoding of the header with an
 * empty (zero-length) proposerPublicKey field. This is the chain's block
 * identity — a child links to its parent by this value, never by merkleRoot.
 */
export function blockHash(block: BlockHashInput): string {
  const msg = canonicalBlockEncoding({
    parentHash: block.parentHash,
    height: block.height,
    timestamp: block.timestamp,
    merkleRoot: block.merkleRoot,
    // proposerPublicKey intentionally omitted -> encoded as zero length
  })
  return createHash("sha256").update(Buffer.from(msg)).digest("hex")
}

export function createBlock(parentHash: string, height: number, transactions: Transaction[]): Block {
  const txBytes = transactions.map((tx) => {
    // for merkle purposes, use JSON stable string: use JSON.stringify since tests will supply deterministic inputs
    return new TextEncoder().encode(JSON.stringify(tx))
  })
  return {
    parentHash,
    height,
    timestamp: Date.now(),
    transactions,
    merkleRoot: merkleRoot(txBytes),
  }
}
