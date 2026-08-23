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

export function merkleRoot(transactions: Uint8Array[] | string[]): string {
  // normalize to leaf hashes (sha256 of each transaction bytes)
  const leaves: Uint8Array[] = (transactions || []).map((t) => sha256(toBytes(t as any)))

  if (leaves.length === 0) {
    return Buffer.from(sha256(new Uint8Array(0))).toString("hex")
  }

  let layer: Uint8Array[] = leaves

  while (layer.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i] // duplicate last node when odd
      const concat = new Uint8Array(left.length + right.length)
      concat.set(left, 0)
      concat.set(right, left.length)
      next.push(sha256(concat))
    }
    layer = next
  }

  return Buffer.from(layer[0]).toString("hex")
}
