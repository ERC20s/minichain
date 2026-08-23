// Minimal Block and Transaction type stubs used by the JSON-RPC layer.
// These are intentionally small so the RPC surface can be reviewed independently
// of the full chain implementation. When richer types exist in the repo they
// should replace these exports.

export type BytesHex = string; // hex encoded bytes, e.g. "0xdeadbeef"

export interface Transaction {
  from: string;
  to: string;
  amount: number;
  nonce?: number;
  signature?: string;
}

export interface Block {
  hash: string;
  height: number;
  parentHash: string;
  merkleRoot?: string;
  timestamp: number;
  transactions: Transaction[];
}
