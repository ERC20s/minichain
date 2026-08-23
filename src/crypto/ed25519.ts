import nacl from "tweetnacl"

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
