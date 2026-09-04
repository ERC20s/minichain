import { createHash } from "crypto"

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(Buffer.from(data)).digest()
}

function toBytes(t: Uint8Array | string): Uint8Array {
  if (typeof t === "string") return utf8Bytes(t)
  return t
}

/**
 * Domain tags. A leaf and an internal node are hashed over DIFFERENT byte
 * spaces, so a 64-byte "transaction" can never be presented as the
 * concatenation of two child hashes (the second-preimage trick), and a promoted
 * leaf can never be confused with an internal node built from it.
 */
export const MERKLE_LEAF_TAG = 0x00
export const MERKLE_NODE_TAG = 0x01

/** sha256(0x00 || bytes) */
export function merkleLeafHash(tx: Uint8Array | string): Uint8Array {
  const bytes = toBytes(tx)
  const preimage = new Uint8Array(1 + bytes.length)
  preimage[0] = MERKLE_LEAF_TAG
  preimage.set(bytes, 1)
  return sha256(preimage)
}

/** sha256(0x01 || left || right) */
export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(1 + left.length + right.length)
  preimage[0] = MERKLE_NODE_TAG
  preimage.set(left, 1)
  preimage.set(right, 1 + left.length)
  return sha256(preimage)
}

/**
 * Hex sha256 Merkle root over a transaction list.
 *
 * Two rules make the root INJECTIVE — different transaction lists always give
 * different roots:
 *
 *  - Domain tags: leaves are sha256(0x00 || tx bytes), internal nodes are
 *    sha256(0x01 || left || right).
 *  - PROMOTION, not duplication: when a layer has an odd width the last node is
 *    carried up to the next layer unchanged. The old code hashed the last node
 *    against itself, which made merkleRoot([a, b, c]) equal to
 *    merkleRoot([a, b, c, c]): a relay could append a copy of the trailing
 *    transaction to an honest block and the block still recomputed to the same
 *    merkleRoot, still carried the proposer's valid header signature and still
 *    had the same blockHash, so src/node.ts accepted the padded list as the tip
 *    and re-broadcast it. Promotion cannot collide because a promoted node
 *    keeps its own tag: the leaf hash of c (tag 0x00) is a different value from
 *    the node hash of (c, c) (tag 0x01).
 *
 * The empty list keeps its historical root — sha256 over no input at all —
 * which src/block.ts and SPEC.md document and test/block-hash.test.ts relies on.
 * That value cannot collide with a real tree either: every tree of one or more
 * transactions is a tagged hash over at least one byte.
 */
export function merkleRoot(transactions: Uint8Array[] | string[]): string {
  const leaves: Uint8Array[] = (transactions || []).map((t) => merkleLeafHash(t as any))

  if (leaves.length === 0) {
    return Buffer.from(sha256(new Uint8Array(0))).toString("hex")
  }

  let layer: Uint8Array[] = leaves

  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 >= layer.length) {
        // odd width: promote the last node unchanged, never duplicate it
        next.push(layer[i])
        break
      }
      next.push(merkleNodeHash(layer[i], layer[i + 1]))
    }
    layer = next
  }

  return Buffer.from(layer[0]).toString("hex")
}
