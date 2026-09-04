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
- Transaction fields: a transaction may carry ONLY sender, recipient, amount, nonce and payload. Any other key is rejected with a CanonicalEncodingError, because a field the encoder does not read is invisible to the signature and to the Merkle leaf (see "Merkle leaf bytes"). Valid transactions encode to exactly the same bytes as before.
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
- Leaf hash: sha256(0x00 || tx bytes), where "tx bytes" are canonicalEncoding(tx) — see "Merkle leaf bytes". Internal node: sha256(0x01 || left || right). The one-byte domain tags keep the two spaces apart, so a 64-byte "transaction" cannot be presented as the concatenation of two child hashes.
- Odd width: the last node of a layer is PROMOTED to the next layer unchanged. It is never hashed against itself.
- Empty list: the root stays sha256 over no input at all, the value src/block.ts documents and test/block-hash.test.ts relies on. It cannot collide with a real tree, since every non-empty tree is a tagged hash over at least one byte.
- What this closes: the old code padded an odd layer with `const right = i + 1 < layer.length ? layer[i + 1] : layer[i]`, which made merkleRoot([a, b, c]) equal to merkleRoot([a, b, c, c]). src/node.ts accepts a gossiped block by recomputing the root from blk.transactions and then verifying the ed25519 signature over the HEADER only, so a relay could append a copy of the trailing transaction to an honest block: same recomputed root, same valid proposer signature, same elected proposer key, same blockHash. The node set the padded block as its tip and re-broadcast it, and two nodes then held the same block hash over different transaction lists — a duplicated transfer nobody signed for. Promotion plus the tags removes the collision: the promoted leaf hash of c (tag 0x00) is not the node hash of (c, c) (tag 0x01).
- Compatibility: this is a wire-visible, breaking format change. Every non-empty block's merkleRoot changes, and so does its blockHash and every header signature over it; nodes on the old rule and nodes on this rule will not accept one another's blocks. Acceptable because no chain is persisted, but any running network must restart from a fresh genesis. No encoding version tag is added: canonicalBlockEncoding is unchanged, only the value of merkleRoot changes.

Merkle leaf bytes (new)
- Rule: a Merkle leaf is hashed over the CANONICAL transaction encoding — sha256(0x00 || canonicalEncoding(tx)) — the same bytes an ed25519 transaction signature is made over. JSON.stringify is no longer used anywhere to build leaves.
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
- Grinding: the seed is the parent's block hash, which the parent's proposer controls through its timestamp, so a proposer can search timestamps to influence who is elected after it. Named here rather than fixed; a VRF or a randomness beacon is the later fix.
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

If this passes, a contributor will open a PR adding src/validators.ts, test/validators.test.ts and this SPEC.md update implementing deterministic stake-weighted selection; reviewers will run npm test and ensure all tests pass.