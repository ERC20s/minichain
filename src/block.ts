import crypto from 'crypto';
import { Transaction, serializeTransaction } from './transaction';

export interface BlockHeader {
  index: number;
  previousHash: string | null;
  timestamp: number;
  merkleRoot: string | null;
  nonce: number;
}

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
}

function stableJSONStringifyHeader(header: BlockHeader): string {
  // Order fields deterministically
  const obj = {
    index: header.index,
    previousHash: header.previousHash,
    timestamp: header.timestamp,
    merkleRoot: header.merkleRoot,
    nonce: header.nonce,
  };
  return JSON.stringify(obj);
}

export function headerHash(header: BlockHeader, transactions: Transaction[]): string {
  const headerJson = stableJSONStringifyHeader(header);
  const txsSerialized = transactions.map(serializeTransaction).join('|');
  const input = headerJson + '|' + txsSerialized;
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function serializeBlock(block: Block): string {
  const headerJson = stableJSONStringifyHeader(block.header);
  const txs = block.transactions.map(serializeTransaction);
  return JSON.stringify({ header: JSON.parse(headerJson), transactions: txs });
}

export function deserializeBlock(s: string): Block {
  const obj = JSON.parse(s);
  const header = obj.header as BlockHeader;
  const transactions = (obj.transactions as string[]).map(t => JSON.parse(t) as Transaction);
  return { header, transactions };
}
