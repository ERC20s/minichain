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

Validator selection (new)
- Purpose: a deterministic, stake-weighted selection function is specified so later cycles can choose block proposers for proof-of-stake.
- Algorithm: given a list of validators (publicKey, stake) and a seed (Uint8Array), compute totalStake (sum of non-negative integer stakes as BigInt). If totalStake is zero or inputs are invalid return null. Hash the seed with sha256, convert the 32-byte hash to a BigInt, take hv % totalStake to obtain a target. Walk validators in input order accumulating stake; the first validator whose cumulative stake exceeds the target is selected. This is deterministic for fixed seed and validator ordering.
- Notes: the seed source is out-of-band and must be provided by the caller; sha256(seed) is simple and deterministic but not a bias-resistant randomness beacon — a VRF or threshold randomness can replace it later.

Proposer eligibility (new)
- Purpose: block acceptance in src/node.ts is now conditional on stake-weighted proposer selection, so the deterministic selector in src/validators.ts actually governs who may extend the chain. Before this cycle any self-consistent keypair could extend the chain.
- Configuration: Node takes an optional fourth constructor argument, `validators?: Validator[]`. An empty or omitted set means open membership and the pre-existing behaviour (signature check only) is unchanged, which keeps test/node-sync.test.ts valid.
- Key encoding: Validator.publicKey is the LOWERCASE hex of the raw 32-byte ed25519 public key. Nodes, tests and fixtures produce it with publicKeyToHex(key) exported from src/validators.ts; the helper also lowercases a string input so a set written by hand cannot disagree about case.
- Seed derivation: the seed for height H is the UTF-8 bytes of `parentHash + ":" + height`, i.e. Node.proposerSeed(blk). It is derivable by every node from data it already has and requires no extra gossip message.
- Rejection rules, applied after height linkage, Merkle root recomputation and ed25519 signature verification, and only when a validator set is configured:
  - selectValidator(validators, seed) returns null (empty set, zero total stake, invalid stake) — the block is rejected.
  - the selected publicKey does not equal publicKeyToHex(m.pubKey) — the block is rejected, even though its signature is valid.
  A rejected block is not stored and not re-broadcast.
- Ordering: selectValidator walks the validator array in input order, so every node must hold the validator list in the same order or nodes will disagree about who is eligible. Validator-set distribution and rotation are out of scope for this cycle.
- Known limits: one eligible proposer per height means the chain stalls at that height if the selected validator is offline — slots, timeouts or a fallback proposer are a later cycle. The seed is derived from block data and is grindable in principle; as already noted under Validator selection, sha256(seed) is not a bias-resistant randomness beacon and a VRF can replace it later.

Files added or changed by this cycle (implementation PR will include):
- SPEC.md (this file, updated to include validator selection)
- src/coding/serialize.ts (canonical block header encoding and types)
- src/crypto/ed25519.ts (ed25519 helpers)
- src/merkle.ts (merkle root computation)
- src/validators.ts (deterministic stake-weighted selector; publicKeyToHex helper)
- src/node.ts (optional validator set; proposer eligibility check before accepting a gossiped block)
- test/node-proposer.test.ts (new: eligible proposer accepted, ineligible signer rejected, open membership unchanged)
- test/block-sign.test.ts (block header signing tests)
- test/transaction-sign.test.ts (transaction signing tests)
- test/merkle.test.ts (merkle tests)
- test/validators.test.ts (new tests for validator selection)

If this passes, a contributor will open a PR adding src/validators.ts, test/validators.test.ts and this SPEC.md update implementing deterministic stake-weighted selection; reviewers will run npm test and ensure all tests pass.