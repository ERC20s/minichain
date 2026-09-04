# minichain
A chain built from scratch in TypeScript - blocks, ed25519 signatures, Merkle roots, PoS, gossip, JSON-RPC.

## Running a node

    npm install
    npm run dev

`examples/run-node.ts` starts one gossip node and, beside it, the read-only
JSON-RPC API. Settings (see `.env.example`; values live on the box, never in the
repository):

- `PORT` — the gossip WebSocket port. Default 9300.
- `PEERS` — comma-separated `ws://host:port` peers to dial.
- `VALIDATORS` — the staked set, `hexkey:stake,hexkey:stake`. Unset means any
  validly signed block is accepted; set means only the stake-elected proposer's.
- `RPC_PORT` — the JSON-RPC HTTP port. Default 9310, `0` turns it off.
- `PROPOSER_KEY` — the 64-hex-character ed25519 **seed** this node mints blocks
  with. Unset (the default) means the node follows and relays and mints nothing.
  A secret: it belongs on the box, never in the repository.
- `PROPOSE_INTERVAL_MS` — how often the proposer loop tries to mint. Default
  2000, minimum 100.

## Producing blocks

With `PROPOSER_KEY` set, the runner calls `Node.proposeBlock(secretKey,
publicKey)` on a timer. One tick:

- refuses immediately unless this key is the stake-elected proposer for the
  current tip (`selectValidator(validators, proposerSeed(tip))`), when a
  validator set is configured;
- takes up to 256 pending transactions from the mempool, in nonce order;
- mints nothing at all when the pool is empty (pass `{ allowEmpty: true }` to
  override), so an idle chain does not fill with empty blocks;
- stamps the block with `max(this node's clock, the parent's timestamp)`;
- signs the header and puts the block through `Node.acceptBlock` — the same and
  only acceptance path a gossiped block takes — and gossips it only if this node
  accepts it. A block we would refuse from a peer is never sent to a peer.

There is still no fork choice: a proposer only ever extends the tip it holds.

## Pending transactions

A gossiped `tx` frame is admitted to this node's mempool (`src/state/mempool.ts`)
only if it passes the same rules a block is judged by — a valid ed25519
signature, a nonce strictly above the last one accepted for that sender, and a
balance covering the amount together with that sender's other pending transfers
— and is relayed to peers **once**, on first admission, so a transaction cannot
loop around the mesh. The pool is bounded (1024 transactions, 64 per sender),
held in memory only, and drained of whatever an accepted block committed.
`Node.submitTransaction(tx)` offers a locally built transaction through the same
rules. Nothing in this path moves the tip: the pool is local policy, not
consensus.

## JSON-RPC (read only)

`src/rpc/server.ts` serves JSON-RPC 2.0 over HTTP on `RPC_PORT`, bound to
`127.0.0.1`. It is **read only**: it reports what this node knows and offers no
way to submit a transaction or a block, so the acceptance rules in `src/node.ts`
remain the only path onto the chain. There is no authentication and no TLS —
anything beyond loopback belongs behind a reverse proxy.

POST only (any other verb answers 405), request bodies capped at 64 KiB, no
batch requests.

| method | params | result |
| --- | --- | --- |
| `chain_height` | none | `{ height }` |
| `chain_tip` | none | `{ hash, parentHash, height, timestamp, merkleRoot, transactionCount }` |
| `chain_getBalance` | `{ account }` or `[account]` | `{ account, balance }` |
| `chain_getNonce` | `{ account }` or `[account]` | `{ account, nonce }` (`null` if unseen) |
| `chain_mempool` | none | `{ enabled, size, pending, truncated }` (pending transaction ids) |
| `chain_validators` | none | `{ validators, totalStake, enforced }` |

    curl -s http://127.0.0.1:9310 \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"chain_tip","id":1}'

Errors use the standard codes: `-32700` parse error, `-32600` invalid request,
`-32601` unknown method, `-32602` invalid params, `-32603` internal error.

## Tests

    npm test

`SPEC.md` records the canonical encodings, the block acceptance rules and this
RPC surface.
