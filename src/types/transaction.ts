export interface Transaction {
  sender: string
  recipient: string
  amount: number
  nonce: number
  payload?: unknown
}

export interface SignedTransaction extends Transaction {
  // raw public key bytes (ed25519) used to verify the signature
  publicKey: Uint8Array
  // raw signature bytes (ed25519, 64 bytes)
  signature: Uint8Array
}
