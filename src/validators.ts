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
 * Canonical encoding of a validator identity.
 *
 * Validator.publicKey is the LOWERCASE hex of the raw 32-byte ed25519 public
 * key. Nodes, tests and validator-set fixtures all go through this helper so
 * they cannot disagree about case or about how bytes become a string.
 */
export function publicKeyToHex(key: Uint8Array | string): string {
  if (typeof key === "string") return key.trim().toLowerCase()
  if (!(key instanceof Uint8Array)) return ""
  return Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function selectValidator(validators: Validator[], seed: Uint8Array): string | null {
  if (!Array.isArray(validators) || !(seed instanceof Uint8Array)) return null
  if (validators.length === 0) return null

  // validate stakes and compute total as BigInt
  let totalStake = BigInt(0)
  for (const v of validators) {
    if (typeof v.stake !== "number" || !Number.isFinite(v.stake) || v.stake < 0 || !Number.isInteger(v.stake)) {
      return null
    }
    totalStake += BigInt(v.stake)
  }

  if (totalStake === BigInt(0)) return null

  const hash = sha256(seed)
  const hv = bytesToBigInt(hash)
  const target = hv % totalStake

  let cum = BigInt(0)
  for (const v of validators) {
    cum += BigInt(v.stake)
    if (target < cum) return v.publicKey
  }

  // should not reach here, but return null defensively
  return null
}
