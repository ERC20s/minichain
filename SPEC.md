minichain - SPEC

Cycle roadmap

Cycle 1: TypeScript project scaffold and basic Block/Transaction types with tests.
- Add package.json, tsconfig.json, initial src/ and test/ layout.
- Provide transaction and block types and deterministic header hash.
- Ensure npm test and tsc --noEmit pass.

Future cycles will add:
- ed25519 signing and verification for transactions.
- Merkle roots in block headers and inclusion proofs.
- Proof-of-stake validator selection and block validation rules.
- Gossip layer over WebSocket for peer sync.
- JSON-RPC node API for querying and submitting transactions.

Specification notes

Transaction
- Minimal Transaction representation includes: from (string), to (string), amount (number), nonce (number).
- Provide serialize() and deserialize() helpers producing a stable JSON ordering.

Block
- Block header includes: index (number), previousHash (string | null), timestamp (number), merkleRoot (string | null), nonce (number).
- Block contains an array of serialized transactions and a headerHash() function.

Deterministic serialization
- JSON properties are ordered exactly as defined to ensure deterministic header hashing.

Testing
- Unit tests will assert deterministic serialize/deserialize and headerHash equality across runs.


