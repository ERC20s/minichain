import { Transaction } from "../types/transaction"

function u16be(len: number): Uint8Array {
  const buf = new Uint8Array(2)
  buf[0] = (len >> 8) & 0xff
  buf[1] = len & 0xff
  return buf
}

function u64be(n: number): Uint8Array {
  const buf = new Uint8Array(8)
  // encode as big-endian uint64
  let hi = Math.floor(n / 2 ** 32)
  let lo = n >>> 0
  buf[0] = (hi >>> 24) & 0xff
  buf[1] = (hi >>> 16) & 0xff
  buf[2] = (hi >>> 8) & 0xff
  buf[3] = hi & 0xff
  buf[4] = (lo >>> 24) & 0xff
  buf[5] = (lo >>> 16) & 0xff
  buf[6] = (lo >>> 8) & 0xff
  buf[7] = lo & 0xff
  return buf
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj)
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]"
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((obj as any)[k]))
      .join(",") +
    "}"
  )
}

export function canonicalEncoding(tx: Transaction): Uint8Array {
  const parts: Uint8Array[] = []
  parts.push(utf8Bytes("tx:"))

  const sBytes = utf8Bytes(tx.sender)
  parts.push(u16be(sBytes.length))
  parts.push(sBytes)

  const rBytes = utf8Bytes(tx.recipient)
  parts.push(u16be(rBytes.length))
  parts.push(rBytes)

  parts.push(u64be(tx.amount))
  parts.push(u64be(tx.nonce))

  if (typeof tx.payload === "undefined") {
    parts.push(u16be(0))
  } else {
    const p = stableStringify(tx.payload)
    const pBytes = utf8Bytes(p)
    parts.push(u16be(pBytes.length))
    parts.push(pBytes)
  }

  // concatenate
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
