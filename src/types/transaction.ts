/**
 * A transaction on the chain.
 *
 * `sender` is the AUTHORITY for the transfer, so on a signed transaction it is
 * not a nickname: it is the lowercase hex of the signer's 32-byte ed25519
 * public key (64 hex characters). Verification derives the key straight from
 * this field, so "who signed" and "who is charged" cannot drift apart.
 *
 * `signature` is the lowercase hex of the 64-byte detached ed25519 signature
 * (128 hex characters) over the CANONICAL encoding of the other five fields —
 * see src/tx.ts. It is optional on this interface only so that an unsigned
 * transaction can be built and then signed; every transaction that reaches a
 * block must carry one (see SignedTransaction, src/block.ts and src/node.ts).
 */
export interface Transaction {
  sender: string
  recipient: string
  amount: number
  nonce: number
  payload?: unknown
  /** lowercase hex, 128 characters — see src/tx.ts */
  signature?: string
}

/** A transaction whose signature is present. The only shape a block may carry. */
export interface SignedTransaction extends Transaction {
  signature: string
}
