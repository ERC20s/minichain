import nacl from "tweetnacl"

export type Keypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** Bytes in a raw ed25519 public key. */
export const ED25519_PUBLIC_KEY_BYTES = 32
/** Bytes in a raw detached ed25519 signature: R (32) || S (32). */
export const ED25519_SIGNATURE_BYTES = 64

/**
 * The group order L = 2^252 + 27742317777372353535851937790883648493, as the
 * 32 little-endian bytes the S half of a signature is compared against.
 *
 * A signature is (R, S) with S a scalar mod L. tweetnacl's verifier reads S as a
 * plain 256-bit integer and never checks it is reduced, so for every valid
 * signature (R, S) the bytes (R, S + L) ALSO verify: S + L still fits in 32
 * bytes and L*B is the identity. That is the classic ed25519 malleability, and
 * on this chain the signature bytes are COMMITTED TO — the Merkle leaf is
 * "stx:" || len || signature || body (src/block.ts) and the mempool id is the
 * hash of that leaf (src/state/mempool.ts) — so without this check one signed
 * transfer has two valid spellings with two different ids, and a relay could
 * rewrite a signature in flight and still pass every rule. RFC 8032 §5.1.7
 * requires S < L; verify() below enforces it.
 */
export const ED25519_GROUP_ORDER_LE: readonly number[] = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
  0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]

export function keypairFromSeed(seed: Uint8Array): Keypair {
  const kp = nacl.sign.keyPair.fromSeed(seed)
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

export function generateKeypair(): Keypair {
  const kp = nacl.sign.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

/**
 * Detached signature over `message`. tweetnacl always reduces S mod L, so a
 * signature made here is canonical and verify() accepts it.
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey)
}

/**
 * Is `sig` the ONE canonical encoding of its signature: exactly 64 bytes whose
 * S half, read little-endian, is strictly below the group order L?
 */
export function isCanonicalSignature(sig: Uint8Array): boolean {
  if (!(sig instanceof Uint8Array) || sig.length !== ED25519_SIGNATURE_BYTES) return false
  // Compare S (bytes 32..63, little-endian) against L from the most
  // significant byte down; the first byte that differs decides.
  for (let i = ED25519_PUBLIC_KEY_BYTES - 1; i >= 0; i--) {
    const s = sig[ED25519_PUBLIC_KEY_BYTES + i]
    const l = ED25519_GROUP_ORDER_LE[i]
    if (s < l) return true
    if (s > l) return false
  }
  // S === L exactly: not reduced
  return false
}

/**
 * Does `sig` verify `message` under `publicKey`?
 *
 * Answers false — never throws — for anything that is not a 32-byte key and a
 * 64-byte CANONICAL signature (S < L, see ED25519_GROUP_ORDER_LE), so every
 * valid signature has exactly one byte encoding and a caller never has to
 * catch a size error from the underlying library.
 */
export function verify(message: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean {
  if (!(message instanceof Uint8Array)) return false
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false
  if (!isCanonicalSignature(sig)) return false
  try {
    return nacl.sign.detached.verify(message, sig, publicKey)
  } catch (e) {
    return false
  }
}
