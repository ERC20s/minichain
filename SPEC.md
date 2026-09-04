Transaction signing

This document specifies how transactions are canonically serialized and signed using ed25519 for the minichain project.

Project goal (from README):
"A chain built from scratch in TypeScript - blocks, ed25519 signatures, Merkle roots, PoS, gossip, JSON-RPC."

Assumption: a TypeScript project scaffold (tsconfig, src/, test/, package.json) exists or will be added by the contributor opening the PR. If proposal #1 scaffold is not present, the contributor will include minimal scaffolding required for building and running tests.

Canonical serialization
- Domain separation: every serialized transaction begins with the ASCII prefix "tx:" (3 bytes) to avoid cross-domain replay between different signed structures.
- Field order: sender, recipient, amount, nonce, payload.
- Types and encodings:
  - sender, recipient: UTF-8 strings (addresses encoded as hex or human-readable). Encoded as their UTF-8 bytes with a 2-byte big-endian length prefix.
  - amount, nonce: unsigned integers encoded as 8-byte big-endian (Uint64) to avoid ambiguity between numbers like 1 and 0001.
  - payload: optional arbitrary JSON object. If present it is JSON-serialized with a stable key ordering (object keys sorted lexicographically) and encoded as UTF-8 with a 2-byte big-endian length prefix. If absent, the length is zero.
- The canonicalEncoding function concatenates: prefix("tx:") || len(sender) || sender || len(recipient) || recipient || amount(8) || nonce(8) || len(payload) || payloadBytes.

Input validation (canonical encoders reject what they cannot represent)
- Principle: the canonical encoders produce the bytes a signature is made over, so they must be injective. An input the format cannot represent is REJECTED with a CanonicalEncodingError (a RangeError subclass exported from src/coding/serialize.ts); it is never truncated, rounded or stringified.
- uint64 fields (tx.amount, tx.nonce, header.height, header.timestamp): must be a number, finite, an integer, >= 0 and <= Number.MAX_SAFE_INTEGER (2**53 - 1). This closes two collisions in the old encoder: amount 1 and amount 1.5 produced identical bytes, and a negative amount encoded as 0xffffffffffffffff, indistinguishable from the maximum uint64. The nominal uint64 range is narrowed to 2**53 - 1 because that is the largest integer a JavaScript number holds exactly; a wider range would need bigint fields and a version tag.
- Length-prefixed fields (sender, recipient, payload, parentHash, merkleRoot, proposerPublicKey): the 2-byte big-endian prefix carries at most 65535 bytes, measured in UTF-8 BYTES, not characters. A longer field throws instead of writing the length modulo 65536 while emitting the full bytes, which would have made the framing non-injective.
- String fields (tx.sender, tx.recipient, header.parentHash, header.merkleRoot): must be strings. A missing field previously encoded as the literal text "undefined", so a transaction with no sender signed as one whose sender was "undefined".
- header.proposerPublicKey: absent or null encodes as a zero length; when present it must be a Uint8Array (raw bytes, never a hex string).
- Transaction fields: a transaction may carry ONLY sender, recipient, amount, nonce, payload and signature. Any other key is rejected with a CanonicalEncodingError, because a field the encoder does not read is invisible to the signature and to the Merkle leaf (see "Merkle leaf bytes"). Valid transactions encode to exactly the same bytes as before.
- signature is a KNOWN-AND-EXCLUDED field (CANONICAL_TX_EXCLUDED_FIELDS in src/coding/serialize.ts): it is accepted on the object and left out of the bytes, because an ed25519 signature cannot be part of its own preimage. The signed bytes are therefore still exactly prefix("tx:") || sender || recipient || amount || nonce || payload, and every signature and test vector made before signatures existed still verifies. The signature is committed to separately, in the Merkle leaf (see "Transaction authorisation").
- Stable JSON (payload): object keys are sorted as before, and values JSON cannot round-trip are rejected — undefined, NaN, Infinity, -Infinity, functions, symbols and bigints all throw, with the path of the offending value in the message.
- Compatibility: the bytes produced for VALID inputs are unchanged, so existing signatures and test vectors still verify and no encoding version tag is introduced. Callers that encode untrusted input must handle the throw; the gossip "blk" handler in src/node.ts already runs inside a try/catch, so a malformed remote block is ignored rather than accepted.

Signing and signature format
- ed25519 (RFC 8032) detached signatures are used.
- Signatures are raw 64-byte binary values. Tests in the repository use Uint8Array values and compare them byte-for-byte. When serialized for storage or transport the signature may be hex or base64 encoded; the code in this cycle returns and accepts raw Uint8Array values.

Test vectors and determinism
- Tests included in this cycle use a fixed 32-byte seed to derive a deterministic keypair and verify that signing the same transaction twice yields identical signatures. Tests also show that tampering with any signed field causes verification to fail.
- The SPEC records the canonical encoding rules above so future implementations can generate identical signing bytes.

Versioning and compatibility
- If the canonical encoding changes in future cycles it must be recorded with a version tag in SPEC.md and code must support selecting the encoding version so older signatures remain verifiable.

Block signing
- This cycle adds a block header canonical encoding and signing rules used for detached ed25519 signatures over block headers.
- Domain separation: every serialized block header begins with the ASCII prefix "blk:" (4 bytes).
- Field order: parentHash, height, timestamp, merkleRoot, proposerPublicKey.
- Types and encodings:
  - parentHash, merkleRoot: UTF-8 strings encoded as their UTF-8 bytes with a 2-byte big-endian length prefix.
  - height, timestamp: unsigned integers encoded as 8-byte big-endian (Uint64).
  - proposerPublicKey: raw bytes encoded with a 2-byte big-endian length prefix. If no proposer key is present the length is zero.
- The canonicalBlockEncoding function concatenates: prefix("blk:") || len(parentHash) || parentHash || height(8) || timestamp(8) || len(merkleRoot) || merkleRoot || len(proposerPublicKey) || proposerPublicKey.
- Signatures are ed25519 detached 64-byte raw values over the canonicalBlockEncoding output.

Block hash and chain linkage (new)
- Purpose: a block must be identified by something that commits to its whole header, so that a child names exactly one parent and history is tamper-evident.
- Block hash: blockHash(block) in src/block.ts returns the lower-case hex sha256 of the domain-separated preimage
  "blkhash:" (8 ASCII bytes) || canonicalBlockEncoding({parentHash, height, timestamp, merkleRoot}).
  The canonical block header encoder from src/coding/serialize.ts is reused unchanged, so the same injectivity and validation rules apply: a header with a missing, mistyped, fractional, negative or over-long field throws a CanonicalEncodingError instead of being hashed.
- proposerPublicKey is ABSENT from the block hash preimage (it therefore encodes as a zero length prefix). The Block interface carries no proposer field and a Uint8Array does not survive JSON.stringify/parse over gossip, so including it would make the hash depend on how a block travelled. Consequence to close later: two blocks that differ only by proposer still have the same block hash.
- The "blkhash:" prefix is distinct from the "blk:" signing prefix, so a block hash preimage can never coincide with the bytes an ed25519 header signature is made over, nor with a Merkle leaf or internal node (which begin with the one-byte tags 0x00 and 0x01, see the Merkle root section).
- Linkage rule: block N+1 is a child of block N when N+1.height === N.height + 1 AND N+1.parentHash === blockHash(N). src/node.ts enforces exactly this in its gossip "blk" handler, before recomputing the Merkle root and verifying the header signature.
- Why not the Merkle root: merkleRoot commits to the transaction list and to nothing else. Two blocks with the same transactions but a different height, timestamp or parent share a root, and every empty block shares one (merkleRoot([]) is sha256 of no input), so a child linked by root attached equally well to any of them and a parent's header could be swapped with every descendant still verifying.
- Compatibility: this is a wire-visible format change. Nodes on the old rule and nodes on this rule will not accept one another's blocks, and any stored chain must be rebuilt from a fresh genesis. No encoding version tag is added because canonicalBlockEncoding itself is unchanged; only what parentHash MEANS changes.
- Genesis: a genesis block's parentHash is an arbitrary caller-chosen string ("0x00" in tests, "genesis" in examples/run-node.ts); nothing verifies it.

Merkle root (src/merkle.ts)
- Purpose: the root must be INJECTIVE over the transaction list — different lists must give different roots — because it is the only thing in a block header that commits to the transactions, and the header signature and blockHash commit only to the root.
- Leaf hash: sha256(0x00 || leaf bytes), where "leaf bytes" are the signed-transaction leaf "stx:" || uint16be(len(signature)) || signature || canonicalEncoding(tx) — see "Merkle leaf bytes" and "Transaction authorisation". Internal node: sha256(0x01 || left || right). The one-byte domain tags keep the two spaces apart, so a 64-byte "transaction" cannot be presented as the concatenation of two child hashes.
- Odd width: the last node of a layer is PROMOTED to the next layer unchanged. It is never hashed against itself.
- Empty list: the root stays sha256 over no input at all, the value src/block.ts documents and test/block-hash.test.ts relies on. It cannot collide with a real tree, since every non-empty tree is a tagged hash over at least one byte.
- What this closes: the old code padded an odd layer with `const right = i + 1 < layer.length ? layer[i + 1] : layer[i]`, which made merkleRoot([a, b, c]) equal to merkleRoot([a, b, c, c]). src/node.ts accepts a gossiped block by recomputing the root from blk.transactions and then verifying the ed25519 signature over the HEADER only, so a relay could append a copy of the trailing transaction to an honest block: same recomputed root, same valid proposer signature, same elected proposer key, same blockHash. The node set the padded block as its tip and re-broadcast it, and two nodes then held the same block hash over different transaction lists — a duplicated transfer nobody signed for. Promotion plus the tags removes the collision: the promoted leaf hash of c (tag 0x00) is not the node hash of (c, c) (tag 0x01).
- Compatibility: this is a wire-visible, breaking format change. Every non-empty block's merkleRoot changes, and so does its blockHash and every header signature over it; nodes on the old rule and nodes on this rule will not accept one another's blocks. Acceptable because no chain is persisted, but any running network must restart from a fresh genesis. No encoding version tag is added: canonicalBlockEncoding is unchanged, only the value of merkleRoot changes.

Merkle leaf bytes (new)
- Rule: a Merkle leaf is hashed over the CANONICAL transaction encoding, now wrapped with the transaction's signature — sha256(0x00 || "stx:" || uint16be(len(signature)) || signature || canonicalEncoding(tx)). The body is still the same bytes an ed25519 transaction signature is made over. JSON.stringify is no longer used anywhere to build leaves.
- Why: JSON.stringify is not injective over transactions and validates nothing. It preserves key insertion order, so {sender, recipient, amount, nonce} and {nonce, amount, recipient, sender} are one logical transaction with two leaf identities and two Merkle roots; it emits null for NaN and Infinity, so a block could commit to amount: NaN, every node would recompute the same root, verify the header signature and accept it; and it copies unknown fields through verbatim. canonicalEncoding is injective and REJECTS what it cannot represent, which is exactly the class of input it was added for.
- Unknown fields: canonicalEncoding now rejects a transaction carrying any key outside sender, recipient, amount, nonce, payload with a CanonicalEncodingError naming the offending keys (CANONICAL_TX_FIELDS is exported). Without this, the encoder would simply not read an extra field, so a relay could bolt junk onto a transaction with the leaf hash, the Merkle root, the block hash and the proposer's header signature all still valid.
- Where the leaves are built: transactionLeaves(transactions) in src/block.ts is the single place; createBlock and the gossip "blk" handler in src/node.ts both call it. Two implementations of the leaf bytes were how the two forms drifted apart in the first place.
- Failure behaviour: a throw is a REJECT. createBlock propagates the CanonicalEncodingError to the proposer rather than building a block over unencodable transactions. In src/node.ts the call sits in its own try/catch that returns from the handler, so the tip does not move and nothing is re-broadcast — the block is dropped before the signature and proposer checks are even reached.
- Compatibility: wire-visible and breaking. Every non-empty block's merkleRoot changes, and with it its blockHash and every header signature over it, so nodes on the old rule and nodes on this rule will not accept one another's blocks and a running network must restart from a fresh genesis. Acceptable because no chain is persisted. No encoding version tag is added: canonicalEncoding's bytes for valid inputs are unchanged (only which inputs are valid, and what is hashed, changed).
- Empty list: unchanged. A block with no transactions still has merkleRoot = sha256 over no input.

Files added or changed for canonical Merkle leaves
- src/coding/serialize.ts (CANONICAL_TX_FIELDS; canonicalEncoding rejects unknown transaction fields)
- src/block.ts (transactionLeaves; createBlock hashes canonical bytes instead of JSON.stringify)
- src/node.ts (the "blk" handler builds leaves with transactionLeaves and returns on a CanonicalEncodingError)
- test/merkle-duplication.test.ts (its local rootOf helper moved to canonicalEncoding)
- test/tx-leaf-canonical.test.ts (new: reordered keys give one root, createBlock refuses NaN and unknown fields, and a gossiped block with an extra field or a NaN amount is dropped while the honest block still propagates)
- SPEC.md (this section)

Files added or changed for the Merkle fix
- src/merkle.ts (tagged leaf/internal hashing, promotion instead of duplication; merkleLeafHash, merkleNodeHash, MERKLE_LEAF_TAG, MERKLE_NODE_TAG exported for tests)
- test/merkle.test.ts (the "odd number duplicates last node" test is replaced by promotion, tagging, padded-list inequality and 64-byte second-preimage cases)
- test/merkle-duplication.test.ts (new: a block built with createBlock, relayed with its last transaction duplicated, is rejected by a Node and leaves the tip unchanged, while the honest block is accepted)
- SPEC.md (this section)

Validator selection (new)
- Purpose: a deterministic, stake-weighted selection function is specified so later cycles can choose block proposers for proof-of-stake.
- Algorithm: given a list of validators (publicKey, stake) and a seed (Uint8Array), first build the CANONICAL validator set, then walk it. Canonicalisation: reject the whole call (return null) if the input is not an array, the seed is not a Uint8Array, any publicKey is not a string, or any stake is not a finite non-negative integer; merge entries that share a publicKey by summing their stakes as BigInt; drop entries whose summed stake is zero; sort the remainder by publicKey using a byte-wise comparison of its UTF-8 bytes (not locale order, not UTF-16 code-unit order). Compute totalStake as the sum of the canonical stakes; if the canonical set is empty or totalStake is zero return null. Hash the seed with sha256, convert the 32-byte hash to a BigInt, take hv % totalStake to obtain a target. Walk the canonical set in canonical order accumulating stake; the first validator whose cumulative stake exceeds the target is selected.
- Ordering rule: the result depends only on the SET of (publicKey, summed stake) pairs and the seed — never on the order the caller assembled its array in. Two nodes holding the same validators and the same seed, but built from a different config order or a different gossip arrival order, elect the same proposer; a node therefore cannot reject a valid block over an ordering difference. A second implementation reproduces the pick by applying the same merge-by-publicKey, drop-zero-stake and byte-wise sort before the cumulative walk.
- Notes: the seed source is out-of-band and must be provided by the caller; sha256(seed) is simple and deterministic but not a bias-resistant randomness beacon — a VRF or threshold randomness can replace it later.
- Key format: a Validator.publicKey is the LOWER-CASE hex of the raw 32-byte ed25519 public key (64 hex characters), the form publicKeyToHex(src/validators.ts) produces from the raw bytes that travel in a gossip envelope's pubKeyHex field. The selector compares publicKey strings byte-wise, so an upper-case or 0x-prefixed entry is a DIFFERENT validator and will never match a key off the wire.

Proposer enforcement in block acceptance (new)
- Purpose: until this cycle the selector existed but nothing called it — any keypair whose header signature verified could extend the chain and be re-broadcast to every peer. Proof of stake was specified and not enforced.
- Proposer seed: proposerSeed(parent) in src/validators.ts returns the UTF-8 bytes of "pos:" || blockHash(parent), where parent is the CURRENT tip. The "pos:" prefix is distinct from "blk:", "blkhash:" and "tx:", so the bytes the selector hashes can never coincide with a signing preimage, a block hash preimage or a Merkle leaf. The seed needs no out-of-band randomness: two nodes on the same tip derive the same seed, and it changes with every accepted block.
- Acceptance rule (src/node.ts, gossip "blk" handler): a Node is constructed with an optional fourth argument, the validator set (default empty). When the set is NON-EMPTY, after the height, parentHash, Merkle root and ed25519 header-signature checks the node computes selectValidator(validators, proposerSeed(tip)) and drops the block unless the elected publicKey equals publicKeyToHex(m.pubKey). The check runs BEFORE this.tip is moved and BEFORE the block is re-broadcast, so a block from a non-proposer neither becomes the tip nor propagates through this node.
- Fail closed: if the configured set elects nobody (selectValidator returns null — every stake zero, or a malformed entry) the node accepts no block at that height rather than falling back to "any valid signature".
- Empty set = today's permissive behaviour: a node built with no validator set behaves exactly as before, which keeps test/node-sync.test.ts, test/block-hash.test.ts and an unconfigured examples/run-node.ts working. The guard therefore protects only nodes that are configured with a set; a network is only as strict as the nodes in it.
- Forking risk: the rule is enforced against each node's OWN validator list. Two nodes with different lists (or different stakes) can elect different proposers for the same height, so one accepts a block the other drops and the chain forks. Until a validator set lives on-chain, the set must be distributed identically to every node.
- Grinding: the seed is the parent's block hash, which the parent's proposer controls through its timestamp, so a proposer can search timestamps to influence who is elected after it. The search is now BOUNDED, not removed: a block's timestamp must lie between its parent's stamp and the accepting node's clock plus MAX_FUTURE_DRIFT_MS (see "Block timestamp bounds" below), so the reachable seeds are the stamps inside that window rather than every integer. A VRF or a randomness beacon is still the fix that removes grinding.
- Configuration: examples/run-node.ts reads the VALIDATORS setting, "hexkey:stake,hexkey:stake" (lower-case hex key, non-negative integer stake, entries separated by commas). A malformed entry is warned about and skipped; unset means no set and thus the permissive path. The name VALIDATORS is declared in the keys: block of the root .d8a and in .env.example; values live on the box, never in the repository.

Files added or changed for proposer enforcement
- src/validators.ts (PROPOSER_SEED_PREFIX, proposerSeed, publicKeyToHex)
- src/node.ts (validator set on the constructor; proposer check before the tip moves and before re-broadcast)
- examples/run-node.ts (VALIDATORS parsing, passed to Node)
- test/node-pos.test.ts (new: the elected proposer's block is accepted and relayed; the other staked validator's and an unstaked key's are not, and do not reach a third node; the no-set default stays permissive)
- .env.example and .d8a keys: (the VALIDATORS name)

Gossip envelope limits (src/gossip/ws.ts)
- Wire format: every gossip frame is a JSON envelope {"type","payloadHex","sigHex?","pubKeyHex?"}. type must be "tx" or "blk"; each hex field must be an even-length string of [0-9a-fA-F] within its maximum (payloadHex 131072 chars = 64 KiB, sigHex 1024, pubKeyHex 1024). A frame that fails any check is dropped silently; it never reaches a listener.
- Size before parse: the receiver rejects an oversized frame BEFORE JSON.parse, so a hostile peer cannot make a node parse and allocate megabytes to have the envelope thrown away afterwards. Two ordered checks do this:
  - MAX_ENVELOPE_BYTES = MAX_ENVELOPE_CHARS * 3, compared against the byte length of the incoming frame without converting it to a string. A UTF-8 sequence never uses more than 3 bytes per UTF-16 code unit, so a frame above this bound cannot decode to a string within the character limit — the check can never drop an envelope the character check would have accepted.
  - MAX_ENVELOPE_CHARS = MAX_PAYLOAD_HEX + MAX_SIG_HEX + MAX_PUBKEY_HEX + 200, compared against the decoded string. The 200 characters cover JSON syntax, field names and quotes; the largest envelope this transport sends adds 66. The limit is derived from the field maxima, so raising a field maximum raises it with no second constant to remember.
- The limit is a transport bound only: it changes no encoding, no signature and no message semantics, and the biggest legal envelope (64 KiB payload with signature and public key) still passes.

Files added or changed by this cycle (implementation PR will include):
- SPEC.md (this file, updated to include validator selection)
- src/coding/serialize.ts (canonical block header encoding and types)
- src/crypto/ed25519.ts (ed25519 helpers)
- src/merkle.ts (merkle root computation)
- src/validators.ts (new: deterministic stake-weighted selector)
- test/block-sign.test.ts (block header signing tests)
- test/transaction-sign.test.ts (transaction signing tests)
- test/merkle.test.ts (merkle tests)
- test/validators.test.ts (new tests for validator selection)
- src/gossip/ws.ts (envelope validation and the pre-JSON.parse size guard described above)
- test/gossip.test.ts (transport tests, including an oversized frame dropped without parsing and a just-under-the-limit envelope still delivered)
- src/block.ts (blockHash: the header hash that identifies a block)
- src/node.ts (the gossip "blk" handler links a child by blockHash(tip) instead of tip.merkleRoot)
- test/block-hash.test.ts (new: look-alike blocks share a merkleRoot but not a blockHash, the hash survives a JSON round trip, and a node whose tip is a look-alike rejects the other chain's child)
- test/node-sync.test.ts (the propagated child is built on blockHash(genesis))
- test/canonical-validation.test.ts (new: the encoders reject fractional, negative and over-range integers, over-long length-prefixed fields, missing or mistyped string fields and non-round-trippable payload values, while the byte vectors for valid inputs stay identical)

Transaction authorisation (new)
- Purpose: until this cycle nothing anywhere checked that a transaction was authorised by the account it spends from. Blocks were signed by their proposer, the Merkle root proved WHICH transactions a block contained, and stake-weighted selection proved WHO was entitled to propose it — but an elected proposer (or, in a validator-less deployment, anyone) could put {sender: "alice", recipient: "me", amount: 1000000} in a block and every node accepted it and re-broadcast it. Transaction signing existed only as a demo in test/transaction-sign.test.ts.
- sender IS the spending key: on any transaction that reaches a block, sender is the LOWER-CASE hex of the signer's raw 32-byte ed25519 public key (64 hex characters), the same form Validator.publicKey uses. Verification derives the key from the field it authorises, so "who signed" and "who is charged" cannot drift apart. Human-readable sender strings are no longer valid in blocks (recipient is still an opaque string; nothing is verified about it).
- signature: the LOWER-CASE hex of the 64-byte detached ed25519 signature (128 hex characters) over transactionSigningBytes(tx) = canonicalEncoding(tx). Upper-case hex, a 0x prefix or any other length is invalid — a second spelling of the same bytes is a second identity.
- API (src/tx.ts): transactionSigningBytes(tx); signTransaction(tx, secretKey) which fills sender in from the key and refuses a sender that is not that key; verifyTransaction(tx) which returns false (never throws) for a missing, malformed, unencodable or wrong-key signature; verifyTransactions(list); assertVerifiedTransaction(tx) for callers that want the reason; TransactionSignatureError.
- Leaf format: transactionLeaf(tx) in src/block.ts hashes "stx:" || uint16be(len(signature)) || signature || canonicalEncoding(tx). The signature is INSIDE the leaf because it is excluded from its own signing preimage; without it a relay could strip a signature, or swap in another account's, and the recomputed root, the block hash and the proposer's header signature would all still match. The "stx:" tag is distinct from "tx:", "blk:", "blkhash:" and "pos:". An unsigned or malformed transaction throws a TransactionSignatureError, so the leaves — and therefore the root — cannot even be recomputed for such a block.
- Block assembly: createBlock refuses to build a block over an unsigned or malformed transaction, so a proposer cannot produce a block its own peers are required to drop.
- Acceptance rule (src/node.ts, gossip "blk" handler): after the height, parentHash and recomputed-merkleRoot checks and before the header signature and proposer checks, the node runs verifyTransaction over every transaction in the block and RETURNS on the first failure. The tip does not move and nothing is re-broadcast, so an unauthorised transfer does not propagate through this node. An empty transaction list passes, as it always did.
- Ordering: the per-transaction check sits after the root check on purpose — the root check is cheap and rejects a mismatched list before any signature work is done.
- Not covered yet: fees, gap-free nonce ordering and persisted account state. The signature proves consent to THIS transfer; replay is covered by "Nonce replay protection" below and affordability by "Account balances and solvency" below. Those remaining items are separate cycles.
- Compatibility: wire-visible and breaking, twice over. Every non-empty block's merkleRoot changes (the leaf format changed), and with it its blockHash and every header signature over it, so nodes on the old rule and nodes on this rule will not accept one another's blocks and a running network must restart from a fresh genesis; and a transaction whose sender is a human-readable name can no longer be included in a block. Acceptable because no chain is persisted. No encoding version tag is added: canonicalEncoding's bytes for the five signed fields are unchanged.

Files added or changed for transaction authorisation
- src/types/transaction.ts (signature field; SignedTransaction; sender documented as the signer's public key hex)
- src/coding/serialize.ts (CANONICAL_TX_EXCLUDED_FIELDS: signature is known and excluded from the signing bytes instead of rejected as unknown)
- src/tx.ts (new: signing bytes, signTransaction, verifyTransaction, verifyTransactions, assertVerifiedTransaction, hex helpers, TransactionSignatureError)
- src/block.ts (SIGNED_TX_LEAF_PREFIX, transactionLeaf; transactionLeaves and createBlock refuse unsigned transactions)
- src/node.ts (the "blk" handler drops a block if any transaction fails verifyTransaction, before the tip moves and before re-broadcast)
- test/helpers/signed-tx.ts (new, not a test file: deterministic accounts and signed-transaction fixtures)
- test/tx-signature.test.ts (new: signing, tampering, wrong-key forgery, malformed hex, the signing preimage unchanged, and the leaf committing to the signature)
- test/node-tx-signature.test.ts (new: an honest block propagates; a forged, an edited and an unsigned transaction each leave the receiving node's tip where it was)
- test/tx-leaf-canonical.test.ts, test/merkle-duplication.test.ts, test/block-hash.test.ts, test/node-sync.test.ts, test/node-pos.test.ts (fixtures are signed transactions now)
- SPEC.md (this section)

Nonce replay protection (new)
- Purpose: an ed25519 transaction signature proves the sender consented to exactly these bytes. It never expires and the bytes never change, so until this cycle the identical signed transaction could be accepted twice. A proposer could copy an already-accepted transaction into the next block, or list it twice in one block, and every check in src/node.ts still passed: transactionLeaves rebuilt the same Merkle root over both copies, verifyTransaction returned true for each (one preimage, one signature), the header signature and the stake-weighted proposer check were untouched. The tip moved and the node re-broadcast the replay. The `nonce` field was already signed and canonically encoded (u64be(tx.nonce)) and nothing read it.
- Rule: a transaction is accepted only when its `nonce` is STRICTLY GREATER than the last nonce this node accepted for the same `sender`, counting transactions earlier in the same block. One offending transaction drops the WHOLE block.
- Strictly increasing, not exactly last + 1: there is no mempool and no account state, so a node cannot distinguish an honest gap (a transaction that never landed) from a forgery, and a sequential rule would stall a sender for ever after one missing transaction. Monotonicity is what defeats replay; gap-free ordering is later work.
- Ledger (src/state/nonces.ts, new): NonceLedger holds lastNonce per sender hex. `new NonceLedger(genesisTransactions)` seeds the highest nonce per sender already on the chain, leniently (a genesis block is an out-of-band fixture; an unreadable entry is skipped). `stage(transactions)` returns a staged sender -> highest-nonce map, or null on the first transaction that does not move its sender forward — a replay, a repeat inside the block, a descending pair from one sender, or a nonce/sender the ledger cannot compare (non-integer, negative, above 2**53 - 1, missing, non-string sender). `commit(staged)` writes with max(), never a blind overwrite, so a stale commit is a no-op. An empty list stages cleanly.
- Acceptance rule (src/node.ts, gossip "blk" handler): staging runs AFTER the per-transaction verifyTransaction loop (an unsigned or forged transaction is cheaper to reject and must not touch nonce state) and BEFORE the header-signature and proposer checks; the handler returns on null. `commit` is called only at the accept point, on the line after `this.tip = blk`, so a block dropped by a later check cannot burn nonces the chain never spent and lock a sender out.
- Ordering duty on proposers: one sender's transactions must appear in a block in ascending nonce order, because staging walks the list in order. A transaction from a rejected block must be re-signed with a nonce above whatever did land — a nonce is never reusable.
- In memory, not persisted: the ledger is rebuilt from the genesis block a Node is constructed with. A node started from a mid-chain snapshot has no history and will accept a replay of anything older than its own start. Persistence, and replaying a stored chain on startup, are separate work.
- Compatibility: not a wire-format change. No encoding, signature, leaf, root or block hash changes, and a block whose senders' nonces rise is accepted exactly as before. What changes is which VALID-looking blocks a node accepts, so a network in which one sender repeats a nonce across blocks now forks at that block.

Files added or changed for nonce replay protection
- src/state/nonces.ts (new: NonceLedger with stage/commit and genesis seeding)
- src/node.ts (a NonceLedger on the constructor, seeded from genesis; stage after the signature loop, commit beside the tip move)
- test/node-nonce-replay.test.ts (new: ledger unit cases — seeding, staging without writing, repeats and descending nonces inside one block, independent senders, uncomparable nonces, no backwards walk — and over gossip: a replayed transaction in block 2 is dropped, the same transaction twice in one block is dropped, rising nonces are accepted, two senders both at nonce 1 are accepted, and a good block still lands after a rejected replay)
- SPEC.md (this section; "Not covered yet" no longer lists nonce replay)

Account balances and solvency (new)
- Threat: a signature proves consent and a rising nonce proves freshness, but neither proves the money exists. An elected proposer could put a correctly signed, correctly nonced transfer of 1e15 from an account that had never been credited into a block, and every check in src/node.ts passed — matching Merkle root, valid transaction signatures, rising nonces, valid header signature, elected proposer. The tip moved and the node relayed value created out of nothing.
- Rule: a transaction is accepted only when its sender's running balance is at least its `amount`, counting transactions earlier in the SAME block. One offending transaction drops the WHOLE block. Money received earlier in the same block is spendable later in that block, so a funded chain of transfers inside one block is valid; a sender splitting more than it holds across two transactions is not.
- Where balances come from: there are no fees, no block reward and no mint transaction, so two seeds open the system. (1) Genesis MINTS: a transaction in the genesis block credits its recipient and debits nobody, because genesis is an out-of-band fixture nothing verifies. (2) An optional opening-balance map, the new trailing constructor argument of Node — `new Node(port, peers, genesis, validators, openingBalances)` — accepted as a plain object, a Map or an array of pairs. Existing four-argument callers are unaffected.
- Amount validation: `amount` must be a non-negative safe integer (the same shape u64be already encodes). A credit that would carry an account past Number.MAX_SAFE_INTEGER is refused rather than rounded, because JavaScript addition stops being exact there. A zero-amount transfer is affordable from an empty account; a self-transfer is debited before it is credited, so the sender must still hold the amount and the net effect is nothing.
- Acceptance rule (src/node.ts, gossip "blk" handler): `this.balances.stage(txs)` runs immediately AFTER the nonce staging and BEFORE the header-signature and proposer checks; the handler returns on null. `commit` is called only at the accept point, beside `this.tip = blk` and `this.nonces.commit(staged)`, so tip, nonces and balances can never disagree and a block dropped by a later check cannot spend balances the chain never spent.
- Staleness: balance writes are absolute (a balance is a value, not a high-water mark like a nonce), so a staged batch carries the ledger revision it was computed against and commit() ignores a batch whose revision no longer matches. Replaying a stale batch cannot resurrect spent money.
- In memory, not persisted: the ledger is rebuilt from the genesis block and the opening balances a Node is constructed with. Nodes in one network must be constructed with the SAME genesis and opening balances or their ledgers disagree and the network forks at the first transfer. Persistence and a chain replayed on startup are separate work.
- Compatibility: not a wire-format change — no encoding, signature, leaf, root or block hash changes. What changes is which VALID-looking blocks a node accepts, so a node with unfunded senders now rejects transfers a node funding them accepts. Test fixtures that expect a transfer to land fund their senders through the new argument (see test/helpers/signed-tx.ts `funded`).

Files added or changed for account balances
- src/state/balances.ts (new: BalanceLedger with balanceOf/stage/commit, genesis minting, opening balances and the revision guard)
- src/node.ts (a BalanceLedger on the constructor, a fifth optional openingBalances argument; stage after the nonce staging, commit beside the tip move)
- test/node-balance.test.ts (new: ledger unit cases — empty ledger, opening balances, genesis minting, staging without writing, an overdraft split across one block, self-transfer, MAX_SAFE_INTEGER overflow, unreadable amounts and accounts, a stale batch — and over gossip: an affordable transfer lands and moves balances, an unaffordable one and a mint-from-nothing are dropped with the tip unmoved, two transfers that together overdraw are dropped, and a good block still lands after a rejected one)
- test/helpers/signed-tx.ts (`funded` helper building an opening-balance map from seed bytes)
- test/node-sync.test.ts, test/node-pos.test.ts, test/node-tx-signature.test.ts, test/merkle-duplication.test.ts, test/tx-leaf-canonical.test.ts, test/node-nonce-replay.test.ts (senders funded so those blocks are still judged on the rule each file is about)
- SPEC.md (this section; "Not covered yet" no longer lists balances and double spends)

Block timestamp bounds (new)
- Threat: every other header field was checked when a block arrived — height, parentHash against blockHash(tip), the recomputed Merkle root, each transaction signature, nonces, balances, the header signature and the elected proposer — while `timestamp` was only COPIED into the header the signature is verified over. A proposer could therefore stamp a block with any integer. Two consequences: (1) grinding — proposerSeed(parent) hashes "pos:" || blockHash(parent) and blockHash covers the timestamp, so an unbounded stamp is an unbounded search over who is elected at the next height; (2) ordering and liveness — a block stamped in the year 3000 was accepted today, and a block stamped before its own parent made the chain's ordering meaningless.
- Rule (src/node.ts, gossip "blk" handler), three checks in order:
  - shape: `timestamp` must be a number, a safe integer and non-negative (the same shape u64be already encodes; the canonical header encoder rejects anything else, but the handler must not depend on reaching it).
  - monotonic: `timestamp` must be >= the CURRENT tip's timestamp. EQUAL is allowed — two blocks minted in the same millisecond are ordinary, and existing fixtures that copy the parent's stamp stay valid. Strictly-increasing is not required and would need a clock resolution the chain does not have.
  - drift: `timestamp` must be <= now() + maxFutureDriftMs, where now() is the accepting node's clock.
- Placement: the three checks run immediately after the height and parentHash linkage checks and BEFORE the Merkle recompute, the transaction signatures, nonce and balance staging, the header signature and the proposer check — cheapest first, and no state is touched. A failing block is dropped exactly as any other failing block: the tip does not move and nothing is re-broadcast.
- Bound: MAX_FUTURE_DRIFT_MS = 120000 (two minutes), exported from src/node.ts. Wide enough for ordinary clock skew between honest peers on unsynchronised boxes; narrow enough that timestamp grinding is a ~120-second search rather than an unbounded one.
- Configuration: a Node takes an optional SIXTH constructor argument, `new Node(port, peers, genesis, validators, openingBalances, { maxFutureDriftMs?, now? })`. maxFutureDriftMs must be a non-negative safe integer or the default stands; now defaults to () => Date.now() and exists so tests can place "now" without waiting. No environment setting is read, so the .d8a keys: block and .env.example are unchanged. Existing five-argument callers, including examples/run-node.ts, are unaffected.
- Clock risk: this is a rule about each node's OWN clock. A node running more than the drift BEHIND its peers will drop honest blocks and stall, which is why the bound is a constructor option rather than a constant only. There is no network time source and none is added here.
- Not a wire-format change: no encoding, signature, leaf, root or block hash changes. What changes is which valid-looking blocks a node accepts, so a network whose proposers stamp blocks backwards or far ahead now forks at that block.

Files added or changed for block timestamp bounds
- src/node.ts (MAX_FUTURE_DRIFT_MS, the NodeOptions argument with maxFutureDriftMs/now, the maxFutureDriftMs and now fields, and the three timestamp checks after the linkage checks)
- test/node-timestamp.test.ts (new: the exported default; equal-to-parent and slightly-ahead stamps accepted and relayed; a backwards stamp, a far-future stamp, a stamp outside a tighter configured drift and a fractional stamp each dropped without reaching a third node; the default drift stands when the option is missing or unusable)
- SPEC.md (this section, and the "Grinding" note under proposer enforcement now records the bound)

If this passes, a contributor will open a PR adding src/validators.ts, test/validators.test.ts and this SPEC.md update implementing deterministic stake-weighted selection; reviewers will run npm test and ensure all tests pass.