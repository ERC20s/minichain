import { createHash } from "crypto"

// Domain separation tags (see SPEC.md, "Merkle tree", version 2).
// Leaves and internal nodes are hashed under different tags so a 64-byte
// "transaction" can never be passed off as an internal node.
export const LEAF_TAG = 0x00
export const NODE_TAG = 0x01

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

/** Leaf hash: sha256(0x00 || txBytes). */
export function hashLeaf(tx: Uint8Array | string): Uint8Array {
  const bytes = toBytes(tx as any)
  const tagged = new Uint8Array(1 + bytes.length)
  tagged[0] = LEAF_TAG
  tagged.set(bytes, 1)
  return sha256(tagged)
}

/** Internal node hash: sha256(0x01 || left || right). */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const tagged = new Uint8Array(1 + left.length + right.length)
  tagged[0] = NODE_TAG
  tagged.set(left, 1)
  tagged.set(right, 1 + left.length)
  return sha256(tagged)
}

export function merkleRoot(transactions: Uint8Array[] | string[]): string {
  // normalize to tagged leaf hashes
  const leaves: Uint8Array[] = (transactions || []).map((t) => hashLeaf(t as any))

  if (leaves.length === 0) {
    // empty tree: the leaf tag over an empty transaction
    return Buffer.from(hashLeaf(new Uint8Array(0))).toString("hex")
  }

  let layer: Uint8Array[] = leaves

  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        next.push(hashNode(layer[i], layer[i + 1]))
      } else {
        // odd layer: promote the lone node unchanged instead of pairing it
        // with itself, so merkleRoot([a,b,c]) !== merkleRoot([a,b,c,c]).
        next.push(layer[i])
      }
    }
    layer = next
  }

  return Buffer.from(layer[0]).toString("hex")
}
