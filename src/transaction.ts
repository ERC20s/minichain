import crypto from 'crypto';

export interface Transaction {
  from: string;
  to: string;
  amount: number;
  nonce: number;
}

// Deterministic serialization: fields in exact order
export function serializeTransaction(tx: Transaction): string {
  const obj = {
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    nonce: tx.nonce,
  };
  return JSON.stringify(obj);
}

export function deserializeTransaction(s: string): Transaction {
  const obj = JSON.parse(s);
  return {
    from: String(obj.from),
    to: String(obj.to),
    amount: Number(obj.amount),
    nonce: Number(obj.nonce),
  };
}

export function transactionHash(tx: Transaction): string {
  const s = serializeTransaction(tx);
  return crypto.createHash('sha256').update(s).digest('hex');
}
