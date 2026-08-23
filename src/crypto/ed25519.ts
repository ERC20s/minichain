import nacl from "tweetnacl"
import { canonicalEncoding } from "../coding/serialize"
import { Transaction, SignedTransaction } from "../types/transaction"

export type Keypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function keypairFromSeed(seed: Uint8Array): Keypair {
  const kp = nacl.sign.keyPair.fromSeed(seed)
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

export function generateKeypair(): Keypair {
  const kp = nacl.sign.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, secretKey)
}

export function verify(message: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, sig, publicKey)
}

export function signTransaction(tx: Transaction, secretKey: Uint8Array): SignedTransaction {
  const msg = canonicalEncoding(tx)
  const signature = sign(msg, secretKey)
  // In tweetnacl, secretKey is 64 bytes where the last 32 bytes are the public key.
  const publicKey = secretKey.length >= 32 ? secretKey.subarray(secretKey.length - 32) : new Uint8Array(0)
  return { ...tx, publicKey, signature }
}

export function verifySignedTransaction(stx: SignedTransaction): boolean {
  const msg = canonicalEncoding(stx)
  return verify(msg, stx.signature, stx.publicKey)
}
