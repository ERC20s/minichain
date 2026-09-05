import { createHash } from "crypto"
import { Block, blockHash } from "./block"

export type Validator = {
  publicKey: string
  stake: number
}

/**
 * Domain separator for the proposer seed, so the bytes selectValidator hashes
 * can never coincide with a block hash preimage ("blkhash:"), a header signing
 * preimage ("blk:") or a Merkle leaf ("tx:").
 */
export const PROPOSER_SEED_PREFIX = "pos:"

/**
 * Separator between the parent hash and the ROUND in a seed for round > 0. It
 * cannot appear inside a block hash (hex only), so "hash || :1" can never be
 * read as some other hash at round 0 — the seeds of two different rounds are
 * distinct byte strings by construction.
 */
export const PROPOSER_ROUND_SEPARATOR = ":"

/**
 * The seed that elects the proposer of the NEXT block, in a given ROUND:
 *
 *   round 0      -> "pos:" || blockHash(parent)
 *   round R > 0  -> "pos:" || blockHash(parent) || ":" || R
 *
 * The parent's block hash commits to its whole header (#42), so the seed moves
 * with every accepted block and two honest nodes holding the same tip derive
 * exactly the same seed without any extra out-of-band randomness.
 *
 * The round is what keeps the chain LIVE. Before it, the seed was a pure
 * function of the tip: if the validator elected for that tip was offline,
 * crashed or partitioned, nobody else could ever propose — the tip never moved,
 * the seed never changed, and the same absent validator was elected for ever.
 * The round is derived by every node from the candidate block's own timestamp
 * against the parent's (see PROPOSER_SLOT_MS and Node.proposerRound in
 * src/node.ts), so no header field, no encoding and no signature changes and
 * two honest nodes still derive the same seed from the same header.
 *
 * Round 0 is byte-for-byte the seed this function always produced, so every
 * existing block, test vector and election is unchanged.
 *
 * It is still not a bias-resistant beacon — a proposer can grind its own
 * block's timestamp to influence who is elected after it, and now also to reach
 * a later round it wins; the search is bounded by MAX_FUTURE_DRIFT_MS, see
 * SPEC.md.
 *
 * Accepts either the parent block or a parent block hash already computed. A
 * round that is not a non-negative safe integer is treated as round 0.
 */
export function proposerSeed(parent: Block | string, round: number = 0): Uint8Array {
  const hash = typeof parent === "string" ? parent : blockHash(parent)
  const r =
    typeof round === "number" && Number.isSafeInteger(round) && round > 0 ? round : 0
  const suffix = r === 0 ? "" : PROPOSER_ROUND_SEPARATOR + String(r)
  return new TextEncoder().encode(PROPOSER_SEED_PREFIX + hash + suffix)
}

/**
 * Lower-case hex of a raw public key, the form validator entries use, so a
 * 32-byte key off the wire can be compared with a Validator.publicKey.
 */
export function publicKeyToHex(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex")
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
