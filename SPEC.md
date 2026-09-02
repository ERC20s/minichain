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

Block hash and chain linkage (blockHash v1, new)
- Purpose: blocks need an identity of their own. Before this cycle a child block linked to its parent by the parent's transaction merkleRoot, which commits only to the transaction list — every empty block hashes to sha256("") — so two different headers with the same transactions were indistinguishable and distinct histories could collide.
- Definition: blockHash(block) = hex-encoded sha256(canonicalBlockEncoding({parentHash, height, timestamp, merkleRoot})), where the proposerPublicKey field of the canonical block encoding is absent and therefore encoded as a zero-length field.
- The proposer public key and the block signature are deliberately NOT committed to by blockHash v1, so any peer can compute a block's hash from the block alone, without the gossip envelope. The trade-off: the same header signed by two different proposers has the same block hash. If a future cycle needs proposer-bound identity it must be recorded as blockHash v2 with a version tag, as required by the versioning rule above.
- Linkage rule: a block is a valid child of the tip when height == tip.height + 1 and parentHash == blockHash(tip). Nodes keep tipHash alongside tip; it is initialised to blockHash(genesis) and updated to blockHash(block) on every accepted block. Linking against merkleRoot is no longer valid and is rejected.
- Block signing is unchanged: the signature is still an ed25519 detached signature over canonicalBlockEncoding of the full header including proposerPublicKey.
- Implemented in src/block.ts (blockHash, BlockHashInput) and src/node.ts (tipHash and the linkage check); covered by test/block-hash.test.ts and test/node-sync.test.ts.

Validator selection (new)
- Purpose: a deterministic, stake-weighted selection function is specified so later cycles can choose block proposers for proof-of-stake.
- Algorithm: given a list of validators (publicKey, stake) and a seed (Uint8Array), compute totalStake (sum of non-negative integer stakes as BigInt). If totalStake is zero or inputs are invalid return null. Hash the seed with sha256, convert the 32-byte hash to a BigInt, take hv % totalStake to obtain a target. Walk validators in input order accumulating stake; the first validator whose cumulative stake exceeds the target is selected. This is deterministic for fixed seed and validator ordering.
- Notes: the seed source is out-of-band and must be provided by the caller; sha256(seed) is simple and deterministic but not a bias-resistant randomness beacon — a VRF or threshold randomness can replace it later.

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

If this passes, a contributor will open a PR adding src/validators.ts, test/validators.test.ts and this SPEC.md update implementing deterministic stake-weighted selection; reviewers will run npm test and ensure all tests pass.