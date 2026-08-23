import { merkleRoot } from "./merkle"
import { Transaction } from "./types/transaction"

export interface Block {
  parentHash: string
  height: number
  timestamp: number
  transactions: Transaction[]
  merkleRoot: string
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
