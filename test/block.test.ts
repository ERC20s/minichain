import { Transaction, serializeTransaction, deserializeTransaction } from '../src/transaction';
import { BlockHeader, Block, headerHash, serializeBlock, deserializeBlock } from '../src/block';

test('transaction serialize/deserialize is deterministic', () => {
  const tx: Transaction = { from: 'alice', to: 'bob', amount: 10, nonce: 1 };
  const s1 = serializeTransaction(tx);
  const s2 = serializeTransaction(deserializeTransaction(s1));
  expect(s1).toBe(s2);
});

test('block serialize/deserialize and headerHash are deterministic', () => {
  const tx1: Transaction = { from: 'alice', to: 'bob', amount: 5, nonce: 1 };
  const tx2: Transaction = { from: 'carol', to: 'dan', amount: 7, nonce: 0 };
  const header: BlockHeader = {
    index: 1,
    previousHash: null,
    timestamp: 1234567890,
    merkleRoot: null,
    nonce: 0,
  };
  const block: Block = { header, transactions: [tx1, tx2] };
  const s = serializeBlock(block);
  const round = deserializeBlock(s);
  expect(JSON.stringify(round.header)).toBe(JSON.stringify(header));
  expect(round.transactions.length).toBe(2);
  const h1 = headerHash(header, [tx1, tx2]);
  const h2 = headerHash(round.header, round.transactions);
  expect(h1).toBe(h2);
});
