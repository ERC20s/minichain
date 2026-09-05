# minichain
A chain built from scratch in TypeScript - blocks, ed25519 signatures, Merkle roots, PoS, gossip, JSON-RPC.

## Running a node

    npm install
    npm run dev

`examples/run-node.ts` starts one gossip node and, beside it, the JSON-RPC API.
Settings (see `.env.example`; values live on the box, never in the repository):

- `PORT` — the gossip WebSocket port. Default 9300.
- `PEERS` — comma-separated `ws://host:port` peers to dial. Start order does not
  matter: a peer that is not listening yet, or that restarts later, is re-dialled
  (see **Reconnecting peers** below).
- `VALIDATORS` — the staked set, `hexkey:stake,hexkey:stake`. Unset means any
  validly signed block is accepted; set means only the stake-elected proposer's.
- `RPC_PORT` — the JSON-RPC HTTP port. Default 9310, `0` turns it off.
- `RPC_HOST` — the host/interface the JSON-RPC HTTP API binds to. Default 127.0.0.1 (loopback); binding to a non-loopback address will disable the chain_sendTransaction write method for safety.
- `GENESIS_BALANCES` — opening balances, `hexkey:amount,hexkey:amount`. There
  are no fees, no block reward and no mint transaction on this chain, so an
  unset value means every account holds 0, every transfer is refused as
  unaffordable and nothing is ever minted. **Local and unverified**: every node
  in one network must be started with the same value, or the ledgers disagree
  and the chain forks at the first transfer.
- `PROPOSER_KEY` — the 64-hex-character ed25519 **seed** this node mints blocks
  with. Unset (the default) means the node follows and relays and mints nothing.
  A secret: it belongs on the box, never in the repository.
- `PROPOSE_INTERVAL_MS` — how often the proposer loop tries to mint. Default
  2000, minimum 100.

## Genesis

Every node starts from the **same** block 0: `createGenesisBlock()`
(`src/block.ts`) — `parentHash` `"genesis"`, height 0, timestamp **0**, no
transactions. It is a pure function, so its `blockHash` is identical in every
process; the runner prints that hash at startup and two terminals must show the
same line. This matters because a child block is linked by
`parentHash === blockHash(parent)`: genesis used to be stamped with `Date.now()`,
so two nodes started a millisecond apart had two different chains and each
silently dropped the other's blocks while sitting at height 0 for ever.

Nodes in one network must also share the same `VALIDATORS` and the same
`GENESIS_BALANCES`. A node that starts late no longer sits at height 0 for ever
— see **Catching up** below.

## Producing blocks

With `PROPOSER_KEY` set, the runner calls `Node.proposeBlock(secretKey,
publicKey)` on a timer. One tick:

- stamps the block first, with `max(this node's clock, the parent's timestamp)`,
  because the stamp decides the slot and the slot decides who is elected;
- refuses immediately unless this key is the stake-elected proposer for the
  current tip **and that slot**
  (`selectValidator(validators, proposerSeed(tip, round))`), when a validator
  set is configured;
- selects up to 256 pending transactions from the mempool, in nonce order,
  SKIPPING any that would not stage against the current nonce and balance
  ledgers (`Mempool.selectForBlock`). A block is judged all-or-nothing, so
  without that skip one pending transfer its sender can no longer pay for —
  which a sender that gossips two transactions to two nodes routinely
  produces — would stop this node minting anything, at every tick, for ever.
  A skipped transaction stays pending and can land at a later height, or in
  the same block once an earlier transaction credits its sender;
- mints nothing at all when the selection is empty (pass `{ allowEmpty: true }`
  to override), so an idle chain does not fill with empty blocks;
- signs the header and puts the block through `Node.acceptBlock` — the same and
  only acceptance path a gossiped block takes — and gossips it only if this node
  accepts it. A block we would refuse from a peer is never sent to a peer.

### Slot rotation

The proposer of a height is not one fixed validator. Every block sits in a
**round**, derived by every node from the block's own header:

```
round = max(0, floor((block.timestamp - tip.timestamp) / PROPOSER_SLOT_MS))   // 6000ms
seed  = "pos:" || blockHash(tip)                 // round 0
      = "pos:" || blockHash(tip) || ":" || round // round 1, 2, 3 ...
```

Without it the chain could halt for good: the seed was a pure function of the
tip, so if the validator elected for that tip was offline, crashed or
partitioned, the tip never moved, the seed never changed and the same absent
validator was elected for ever — no error, no recovery. Now, one slot after the
tip, a different validator is elected and the chain carries on.

Round 0 is byte-for-byte the old seed, so a healthy chain — where every block is
minted well inside its parent's slot — elects exactly who it elected before.
Nothing is added to the header: the round is derived, so no encoding, block
hash, signature or Merkle rule changes, and `PROPOSER_SLOT_MS` is a consensus
constant rather than a setting, because a node using a different slot length
would elect a different proposer.

The trade-off: if round 0's winner is merely slow rather than absent, two valid
blocks can appear at one height. There is still no fork choice — a proposer only
ever extends the tip it holds, and a node keeps the first valid block it saw at
a height — so the slot is kept wide to keep that window small.

## Catching up

A node that joins late, or that misses a `blk` frame, used to stop following the
chain in silence: `acceptBlock` only ever takes the block at `tip.height + 1`, so
everything after the gap was a future block and was dropped.

Two things fix that:

- every **accepted** block is kept, sealed with the header signature and
  proposer key it was judged under, in a bounded store
  (`src/state/chain.ts`, the last 1024 heights; genesis is never stored, because
  every node builds its own with `createGenesisBlock()`);
- a third gossip frame, `req`, whose payload is `{"from": <height>, "max":
  <count>}`. A node that refuses a block from **above** its own gap broadcasts
  one `req` for `tip.height + 1`, at most once a second. A node that holds those
  heights answers with up to 32 consecutive blocks as ordinary `blk` frames,
  sent back **to the asker only** — one peer's gap does not re-flood the mesh.

Nothing is trusted along the way: a synced block goes through the same
`Node.acceptBlock` as any other — linkage, timestamp, Merkle root, every
transaction signature, nonces, balances, the header signature and the
stake-elected proposer — so a peer that answers with rubbish only wastes its own
bandwidth. Applying the batch in order is what makes it work: each block in turn
becomes the tip the next one is judged against.

A node also asks the moment a peer link comes up — see **Reconnecting peers**
below — so a node that reconnects to a quiet chain does not sit at its old tip
waiting for the next block to be minted.

Limits worth knowing: a node more than 1024 blocks behind (or behind a peer whose
window has moved past its tip) cannot be helped this way and must restart from
genesis, nothing is persisted across restarts, and there is still no fork choice.

## Reconnecting peers

Each `PEERS` entry is dialled and **kept** dialled (`src/gossip/ws.ts`). The
transport used to dial every peer exactly once, at startup: a dial that failed
was forgotten and a peer that restarted was removed from the outbound set for
good, so `broadcast()` wrote into an empty set and the node gossiped into
silence. Two everyday things did it — starting a node before the peer named in
`PEERS` was listening, and restarting any node.

Now a peer socket that closes or errors is re-dialled after a backoff: 500 ms,
doubling to a ceiling of 15 s, plus up to 25% jitter so a mesh restarted together
does not reconnect in lockstep. The delay resets to 500 ms as soon as the socket
opens, only one re-dial is ever scheduled per peer (an `error` is normally
followed by a `close`, and that pair must not double the dial rate), and
`GossipNode.close()` clears every pending timer and stops re-dialling for good.
The timers are `unref`'d, so a pending re-dial never keeps a process or a test
run alive.

When an outbound socket opens, the transport fires `onPeerOpen(url)` and the node
sends one catch-up `req` (rate limited exactly as any other, one per second), so
a node that has just reconnected asks for `tip.height + 1` immediately.

A peer that is permanently gone is still dialled once every 15 s or so for as
long as the node runs; nothing is dropped from `PEERS` at runtime, and there is
no peer discovery.

## Pending transactions

A gossiped `tx` frame is admitted to this node's mempool (`src/state/mempool.ts`)
only if it passes the same rules a block is judged by — a valid ed25519
signature, a nonce strictly above the last one accepted for that sender, and a
balance covering the amount together with that sender's other pending transfers
— and is relayed to peers **once**, on first admission, so a transaction cannot
loop around the mesh. The pool is bounded (1024 transactions, 64 per sender),
held in memory only, and drained of whatever an accepted block committed.
`Node.submitTransaction(tx)` offers a locally built transaction through the same
rules, and `chain_sendTransaction` (above) is the door to it from outside the
process. Nothing in this path moves the tip: the pool is local policy, not
consensus.

End to end, on one funded node: start it with `GENESIS_BALANCES` and
`PROPOSER_KEY` set, POST a signed transfer to `chain_sendTransaction`, and the
next proposer tick logs `minted block 1 with 1 transaction(s)` while
`chain_height` moves off 0.

## JSON-RPC

`src/rpc/server.ts` serves JSON-RPC 2.0 over HTTP on `RPC_PORT`, bound to
`127.0.0.1`. Everything except `chain_sendTransaction` is a pure read. No method
can submit a **block**, so the acceptance rules in `src/node.ts` remain the only
path onto the chain. There is no authentication and no TLS — anything beyond
loopback belongs behind a reverse proxy.

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
| `chain_sendTransaction` **(write, loopback only)** | `{ transaction }` or `[transaction]` | `{ admitted, id, reason }` |

    curl -s http://127.0.0.1:9310 \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"chain_tip","id":1}'

    curl -s http://127.0.0.1:9310 \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"chain_sendTransaction","id":1,
           "params":{"transaction":{"sender":"<hex pubkey>","recipient":"bob",
                     "amount":25,"nonce":1,"signature":"<128 hex>"}}}'

`chain_sendTransaction` hands an already-signed transaction to
`Node.submitTransaction` — the same mempool rules a gossiped `tx` frame passes,
and the same relay-on-admission — and returns the pool's own answer. A refusal is
a **result**, not an error: `admitted` is `false` and `reason` is one of
`unauthorised`, `replayed`, `unaffordable`, `duplicate`, `pool-full`,
`sender-full`, `malformed`. `id` is the transaction id `chain_mempool` lists. The
transaction reaches the chain only when the elected proposer mints it.

The write is served **only on a loopback bind** (`127.0.0.0/8`, `::1`,
`localhost`): widening the bind turns it off — answering `-32601` with
`data.reason` `not-loopback` — rather than silently opening a write port. A node
built without `submitTransaction` answers `-32601` with `data.reason`
`unsupported`.

Errors use the standard codes: `-32700` parse error, `-32600` invalid request,
`-32601` unknown method, `-32602` invalid params, `-32603` internal error.

## Tests

    npm test

`SPEC.md` records the canonical encodings, the block acceptance rules and this
RPC surface.
