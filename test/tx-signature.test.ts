import { createBlock, transactionLeaf } from "../src/block"
import { canonicalEncoding, CanonicalEncodingError } from "../src/coding/serialize"
import { sign } from "../src/crypto/ed25519"
import {
  bytesToHex,
  signTransaction,
  transactionSigningBytes,
  TransactionSignatureError,
  TX_SIGNATURE_HEX_LENGTH,
  verifyTransaction,
  verifyTransactions,
} from "../src/tx"
import { Transaction } from "../src/types/transaction"
import { account, accountHex, signedTx } from "./helpers/signed-tx"

/**
 * Per-transaction authorisation.
 *
 * Before this, a Transaction was five unauthenticated fields: the block was
 * signed by its proposer and the Merkle root proved which transactions the
 * block contained, but nothing proved the SENDER had agreed to any of them.
 */
describe("transaction signatures", () => {
  const alice = account(101)
  const aliceHex = accountHex(101)
  const mallory = account(102)

  it("signs with the sender's key and fills sender in from it", () => {
    const tx = signTransaction(
      { recipient: "bob", amount: 5, nonce: 1 },
      alice.secretKey
    )
    expect(tx.sender).toBe(aliceHex)
    expect(tx.sender).toMatch(/^[0-9a-f]{64}$/)
    expect(tx.signature).toMatch(
      new RegExp(`^[0-9a-f]{${TX_SIGNATURE_HEX_LENGTH}}$`)
    )
    expect(verifyTransaction(tx)).toBe(true)
  })

  it("refuses to sign for a sender that is not the signing key", () => {
    expect(() =>
      signTransaction(
        { sender: accountHex(103), recipient: "bob", amount: 5, nonce: 1 },
        alice.secretKey
      )
    ).toThrow(TransactionSignatureError)
  })

  it("keeps the signing preimage exactly as it was: signature is excluded", () => {
    const body: Transaction = {
      sender: aliceHex,
      recipient: "bob",
      amount: 5,
      nonce: 1,
    }
    const signed = signTransaction(
      { recipient: "bob", amount: 5, nonce: 1 },
      alice.secretKey
    )
    // the bytes signed over are the five fields and nothing else, so signatures
    // and test vectors made before `signature` existed still verify
    expect(Array.from(transactionSigningBytes(signed))).toEqual(
      Array.from(canonicalEncoding(body))
    )
    expect(bytesToHex(sign(canonicalEncoding(body), alice.secretKey))).toBe(
      signed.signature
    )
  })

  describe("verifyTransaction answers false rather than throwing", () => {
    const tx = signedTx(101, { recipient: "bob", amount: 5, nonce: 1 })

    it("rejects a tampered amount", () => {
      expect(verifyTransaction({ ...tx, amount: 5000000 })).toBe(false)
      expect(verifyTransaction({ ...tx, recipient: "mallory" })).toBe(false)
      expect(verifyTransaction({ ...tx, nonce: 2 })).toBe(false)
    })

    it("rejects a missing or malformed signature", () => {
      const { signature, ...unsigned } = tx as any
      expect(verifyTransaction(unsigned)).toBe(false)
      expect(verifyTransaction({ ...tx, signature: "" })).toBe(false)
      expect(verifyTransaction({ ...tx, signature: "zz" + signature.slice(2) })).toBe(false)
      // uppercase hex is a second spelling of the same bytes; only one is valid
      expect(verifyTransaction({ ...tx, signature: signature.toUpperCase() })).toBe(false)
    })

    it("rejects a transaction signed by the wrong key", () => {
      // Mallory signs her own transfer, then rewrites the sender to Alice
      const hers = signTransaction(
        { recipient: "mallory", amount: 1000000, nonce: 1 },
        mallory.secretKey
      )
      const forged: Transaction = { ...hers, sender: aliceHex }
      expect(verifyTransaction(hers)).toBe(true)
      expect(verifyTransaction(forged)).toBe(false)
    })

    it("rejects a bare mint with no signature at all", () => {
      expect(
        verifyTransaction({
          sender: aliceHex,
          recipient: "mallory",
          amount: 1000000,
          nonce: 1,
        })
      ).toBe(false)
    })

    it("rejects a sender that is not a 32-byte public key", () => {
      const named = { ...tx, sender: "alice" }
      expect(verifyTransaction(named)).toBe(false)
    })

    it("passes an empty list and fails a list with one bad transaction", () => {
      expect(verifyTransactions([])).toBe(true)
      expect(verifyTransactions([tx])).toBe(true)
      expect(verifyTransactions([tx, { ...tx, amount: 9 }])).toBe(false)
    })
  })

  describe("the Merkle leaf commits to the signature", () => {
    const tx = signedTx(101, { recipient: "bob", amount: 5, nonce: 1 })
    const other = signedTx(101, { recipient: "bob", amount: 6, nonce: 2 })

    it("changes when the signature is swapped, though the body is identical", () => {
      const swapped: Transaction = { ...tx, signature: other.signature }
      expect(Array.from(canonicalEncoding(swapped))).toEqual(
        Array.from(canonicalEncoding(tx))
      ) // same signed body...
      expect(Array.from(transactionLeaf(swapped))).not.toEqual(
        Array.from(transactionLeaf(tx))
      ) // ...different leaf, so a swap changes the root
      expect(createBlock("0x00", 1, [swapped]).merkleRoot).not.toBe(
        createBlock("0x00", 1, [tx]).merkleRoot
      )
    })

    it("is domain separated from the bare signing preimage", () => {
      const leaf = Buffer.from(transactionLeaf(tx))
      expect(leaf.slice(0, 4).toString()).toBe("stx:")
      // "stx:" || uint16be(64) || signature || canonicalEncoding(tx)
      expect(leaf[4]).toBe(0)
      expect(leaf[5]).toBe(64)
      expect(leaf.slice(6, 70).toString("hex")).toBe(tx.signature)
      expect(Array.from(leaf.slice(70))).toEqual(
        Array.from(canonicalEncoding(tx))
      )
    })
  })

  describe("createBlock refuses what a peer would drop", () => {
    it("throws on an unsigned transaction", () => {
      expect(() =>
        createBlock("0x00", 1, [
          { sender: accountHex(101), recipient: "bob", amount: 1, nonce: 1 },
        ])
      ).toThrow(TransactionSignatureError)
    })

    it("still throws on a transaction the encoder cannot represent", () => {
      const tx = signedTx(101, { recipient: "bob", amount: 5, nonce: 1 })
      expect(() => createBlock("0x00", 1, [{ ...tx, amount: NaN }])).toThrow(
        CanonicalEncodingError
      )
    })
  })
})
