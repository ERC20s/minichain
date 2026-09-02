import { createHash } from "crypto"

export type Validator = {
  publicKey: string
  stake: number
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(Buffer.from(data)).digest()
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = Buffer.from(bytes).toString("hex")
  if (hex === "") return BigInt(0)
  return BigInt("0x" + hex)
}

/**
 * Byte-wise comparison of two publicKey strings, over their UTF-8 bytes.
 * Independent of locale and of JavaScript's UTF-16 code-unit ordering, so a
 * second implementation in another language reproduces the same order.
 */
function comparePublicKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

/**
 * Build the canonical validator set from an arbitrary caller-supplied array:
 * entries sharing a publicKey are merged by summing their stakes, entries with
 * zero stake are dropped, and the result is sorted byte-wise by publicKey.
 * Returns null if any entry is invalid (the caller then returns null too).
 */
function canonicalValidators(validators: Validator[]): { publicKey: string; stake: bigint }[] | null {
  const merged = new Map<string, bigint>()

  for (const v of validators) {
    if (!v || typeof v.publicKey !== "string") return null
    if (typeof v.stake !== "number" || !Number.isFinite(v.stake) || v.stake < 0 || !Number.isInteger(v.stake)) {
      return null
    }
    const previous = merged.get(v.publicKey) ?? BigInt(0)
    merged.set(v.publicKey, previous + BigInt(v.stake))
  }

  const canonical: { publicKey: string; stake: bigint }[] = []
  for (const [publicKey, stake] of merged) {
    // A validator with no stake can never be selected; dropping it here keeps
    // the cumulative walk free of zero-width slots.
    if (stake > BigInt(0)) canonical.push({ publicKey, stake })
  }

  canonical.sort((x, y) => comparePublicKeys(x.publicKey, y.publicKey))
  return canonical
}

export function selectValidator(validators: Validator[], seed: Uint8Array): string | null {
  if (!Array.isArray(validators) || !(seed instanceof Uint8Array)) return null
  if (validators.length === 0) return null

  // Canonicalise first: the answer must not depend on the order the caller
  // happened to assemble its validator array in (config order, gossip arrival
  // order, a re-serialised registry) — two honest nodes with the same set and
  // the same seed must elect the same proposer.
  const canonical = canonicalValidators(validators)
  if (canonical === null) return null
  if (canonical.length === 0) return null

  let totalStake = BigInt(0)
  for (const v of canonical) totalStake += v.stake

  if (totalStake === BigInt(0)) return null

  const hash = sha256(seed)
  const hv = bytesToBigInt(hash)
  const target = hv % totalStake

  let cum = BigInt(0)
  for (const v of canonical) {
    cum += v.stake
    if (target < cum) return v.publicKey
  }

  // should not reach here, but return null defensively
  return null
}
