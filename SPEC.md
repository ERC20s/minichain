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

Validator selection (new)
- Purpose: a deterministic, stake-weighted selection function is specified so later cycles can choose block proposers for proof-of-stake.
- Algorithm: given a list of validators (publicKey, stake) and a seed (Uint8Array), first build the CANONICAL validator set, then walk it. Canonicalisation: reject the whole call (return null) if the input is not an array, the seed is not a Uint8Array, any publicKey is not a string, or any stake is not a finite non-negative integer; merge entries that share a publicKey by summing their stakes as BigInt; drop entries whose summed stake is zero; sort the remainder by publicKey using a byte-wise comparison of its UTF-8 bytes (not locale order, not UTF-16 code-unit order). Compute totalStake as the sum of the canonical stakes; if the canonical set is empty or totalStake is zero return null. Hash the seed with sha256, convert the 32-byte hash to a BigInt, take hv % totalStake to obtain a target. Walk the canonical set in canonical order accumulating stake; the first validator whose cumulative stake exceeds the target is selected.
- Ordering rule: the result depends only on the SET of (publicKey, summed stake) pairs and the seed — never on the order the caller assembled its array in. Two nodes holding the same validators and the same seed, but built from a different config order or a different gossip arrival order, elect the same proposer; a node therefore cannot reject a valid block over an ordering difference. A second implementation reproduces the pick by applying the same merge-by-publicKey, drop-zero-stake and byte-wise sort before the cumulative walk.
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
- test/canonical-validation.test.ts (new: the encoders reject fractional, negative and over-range integers, over-long length-prefixed fields, missing or mistyped string fields and non-round-trippable payload values, while the byte vectors for valid inputs stay identical)

If this passes, a contributor will open a PR adding src/validators.ts, test/validators.test.ts and this SPEC.md update implementing deterministic stake-weighted selection; reviewers will run npm test and ensure all tests pass.