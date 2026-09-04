import { canonicalEncoding } from "./coding/serialize"
import { sign, verify } from "./crypto/ed25519"
import { SignedTransaction, Transaction } from "./types/transaction"

/**
 * Per-transaction ed25519 authorisation.
 *
 * Until this module existed nothing anywhere checked that a transaction was
 * authorised by the account it spends from: a Transaction was five plain fields
 * and an elected proposer could put {sender: "alice", recipient: "me",
 * amount: 1000000} in a block that every node accepted and relayed. Blocks were
 * signed; the transactions inside them were not.
 *
 * The rules, in one place:
 *
 *  - `sender` IS the spending key: the lowercase hex of the signer's 32-byte
 *    ed25519 public key (64 hex characters). Verification derives the key from
 *    the field it authorises, so there is no separate "from" to disagree with.
 *  - the signed bytes are canonicalEncoding(tx) — the same injective, validating
 *    encoding the Merkle leaves and the older signing tests already use, with
 *    `signature` excluded from its own preimage. Signatures and vectors made
 *    before this change still verify.
 *  - `signature` is the lowercase hex of the 64-byte detached signature.
 *
 * Nothing here trusts its input: every helper that can be handed gossip data
 * validates shape before it touches the crypto, and verifyTransaction answers
 * false rather than throwing, so a caller can never "accept on error".
 */

/** Bytes in a raw ed25519 public key. */
export const TX_PUBLIC_KEY_BYTES = 32
/** Bytes in a raw detached ed25519 signature. */
export const TX_SIGNATURE_BYTES = 64
/** Hex characters in `sender`. */
export const TX_SENDER_HEX_LENGTH = TX_PUBLIC_KEY_BYTES * 2
/** Hex characters in `signature`. */
export const TX_SIGNATURE_HEX_LENGTH = TX_SIGNATURE_BYTES * 2

const LOWERCASE_HEX = /^[0-9a-f]*$/

/**
 * A transaction that is missing, malformed or wrongly signed. Callers handling
 * untrusted input (the gossip handler, block assembly) treat this as "drop it".
 */
export class TransactionSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransactionSignatureError"
    Object.setPrototypeOf(this, TransactionSignatureError.prototype)
  }
}

/** Lowercase hex of raw bytes. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

/** Strict lowercase-hex decoding: exact length, no 0x prefix, no uppercase. */
export function hexToBytes(
  hex: unknown,
  field: string,
  expectedBytes: number
): Uint8Array {
  if (typeof hex !== "string") {
    throw new TransactionSignatureError(
      `${field} must be a string, got ${hex === null ? "null" : typeof hex}`
    )
  }
  if (hex.length !== expectedBytes * 2) {
    throw new TransactionSignatureError(
      `${field} must be ${expectedBytes * 2} hex characters, got ${hex.length}`
    )
  }
  if (!LOWERCASE_HEX.test(hex)) {
    throw new TransactionSignatureError(
      `${field} must be lowercase hex; anything else is a second spelling of the same value`
    )
  }
  const out = new Uint8Array(expectedBytes)
  for (let i = 0; i < expectedBytes; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

/**
 * The bytes an ed25519 transaction signature is made over.
 *
 * This is canonicalEncoding, unchanged: "tx:" || sender || recipient || amount
 * || nonce || payload, with `signature` a known-and-excluded field. It throws a
 * CanonicalEncodingError on anything the format cannot represent exactly.
 */
export function transactionSigningBytes(tx: Transaction): Uint8Array {
  return canonicalEncoding(tx)
}

/** The raw 64 signature bytes of a signed transaction, or a throw. */
export function transactionSignatureBytes(tx: Transaction): Uint8Array {
  if (tx === null || typeof tx !== "object") {
    throw new TransactionSignatureError("transaction must be an object")
  }
  if (typeof tx.signature === "undefined") {
    throw new TransactionSignatureError(
      "transaction is unsigned: every transaction in a block must carry a signature"
    )
  }
  return hexToBytes(tx.signature, "tx.signature", TX_SIGNATURE_BYTES)
}

/** A transaction to be signed: the signer's key supplies `sender`. */
export type UnsignedTransaction = Omit<Transaction, "sender" | "signature"> & {
  sender?: string
}

/**
 * Sign `tx` with `secretKey` (the 64-byte tweetnacl secret key, whose trailing
 * 32 bytes are the public key) and return the signed transaction.
 *
 * `sender` is filled in from the key. Passing a `sender` that is not that key is
 * an error rather than a silent overwrite: it is exactly the mistake this whole
 * change exists to catch.
 */
export function signTransaction(
  tx: UnsignedTransaction,
  secretKey: Uint8Array
): SignedTransaction {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new TransactionSignatureError(
      "secretKey must be the 64-byte ed25519 secret key"
    )
  }
  const senderHex = bytesToHex(secretKey.slice(32))
  if (typeof tx.sender === "string" && tx.sender !== senderHex) {
    throw new TransactionSignatureError(
      `tx.sender ${tx.sender} is not the signing key ${senderHex}`
    )
  }
  const rest = { ...(tx as unknown as Record<string, unknown>) }
  delete rest.signature
  const body = ({ ...rest, sender: senderHex } as unknown) as Transaction
  const signature = bytesToHex(sign(transactionSigningBytes(body), secretKey))
  return { ...body, signature }
}

/**
 * Is this transaction authorised by the key its `sender` names?
 *
 * Answers false — never throws — for a missing, malformed, wrong-key or
 * unencodable transaction, so the gossip handler can drop a block on a single
 * falsy answer.
 */
export function verifyTransaction(tx: Transaction): boolean {
  try {
    const signature = transactionSignatureBytes(tx)
    const publicKey = hexToBytes(tx.sender, "tx.sender", TX_PUBLIC_KEY_BYTES)
    const message = transactionSigningBytes(tx)
    return verify(message, signature, publicKey)
  } catch (e) {
    return false
  }
}

/** verifyTransaction as an assertion, for callers that want the reason. */
export function assertVerifiedTransaction(tx: Transaction): SignedTransaction {
  const signature = transactionSignatureBytes(tx)
  const publicKey = hexToBytes(tx.sender, "tx.sender", TX_PUBLIC_KEY_BYTES)
  if (!verify(transactionSigningBytes(tx), signature, publicKey)) {
    throw new TransactionSignatureError(
      `transaction signature does not verify against sender ${tx.sender}`
    )
  }
  return tx as SignedTransaction
}

/** True when every transaction in the list verifies (an empty list passes). */
export function verifyTransactions(transactions: Transaction[]): boolean {
  const list = transactions || []
  for (const tx of list) {
    if (!verifyTransaction(tx)) return false
  }
  return true
}
