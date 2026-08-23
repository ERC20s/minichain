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

Files added or changed by this cycle (implementation PR will include):
- SPEC.md (this file, updated to include block signing)
- src/coding/serialize.ts (adds canonicalBlockEncoding and CanonicalBlockHeader type)
- test/block-sign.test.ts (new tests for block header signing and tamper checks)

If this passes, a contributor will open a PR that merges these SPEC and code changes into main and a separate Code proposal will be used to merge after review.
