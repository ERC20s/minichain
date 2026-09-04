import { Node } from "../src/node"
import { keypairFromSeed, sign, Keypair } from "../src/crypto/ed25519"
import { Block, blockHash, createBlock, transactionLeaves } from "../src/block"
import {
  canonicalBlockEncoding,
  canonicalEncoding,
  CanonicalEncodingError,
} from "../src/coding/serialize"
import { merkleRoot } from "../src/merkle"
import { TransactionSignatureError } from "../src/tx"
import { Transaction } from "../src/types/transaction"
import { funded, signedTx } from "./helpers/signed-tx"

function wait(ms: number) { return new Promise((res) => setTimeout(res, ms)) }

function kp(seedByte: number): Keypair {
  const seed = new Uint8Array(32)
  seed[0] = seedByte
  return keypairFromSeed(seed)
}

function signBlock(blk: Block, keypair: Keypair): Uint8Array {
  const msg = canonicalBlockEncoding({
    parentHash: blk.parentHash,
    height: blk.height,
    timestamp: blk.timestamp,
    merkleRoot: blk.merkleRoot,
    proposerPublicKey: keypair.publicKey,
  })
  return sign(msg, keypair.secretKey)
}

function jsonRoot(txs: unknown[]): string {
  return merkleRoot(txs.map((tx) => new TextEncoder().encode(JSON.stringify(tx))))
}

/**
 * Merkle leaves are the canonical transaction encoding, not JSON.stringify.
 *
 * JSON.stringify is not injective over transactions and validates nothing: key
 * insertion order changes the bytes, NaN and Infinity become null, and unknown
 * fields ride along untouched. canonicalEncoding is the format ed25519
 * transaction signatures already use, and it rejects what it cannot represent.
 */
describe("merkle leaves are canonical transaction bytes", () => {
  const proposer = kp(51)

  const txs: Transaction[] = [
    signedTx(1, { recipient: "bob", amount: 1, nonce: 1 }),
    signedTx(2, { recipient: "carol", amount: 2, nonce: 1 }),
    signedTx(3, { recipient: "alice", amount: 3, nonce: 1 }),
  ]

  const genesis = createBlock("0x00", 0, [])
  const honest = createBlock(blockHash(genesis), 1, txs)

  describe("leaf identity", () => {
    it("gives one root whatever order the keys were written in", () => {
      const written: Transaction[] = [
        signedTx(4, { recipient: "bob", amount: 1, nonce: 1 }),
      ]
      const w = written[0]
      const reordered = [
        {
          signature: w.signature,
          nonce: w.nonce,
          amount: w.amount,
          recipient: w.recipient,
          sender: w.sender,
        },
      ] as unknown as Transaction[]

      // JSON.stringify keeps insertion order, so the old leaves differed...
      expect(JSON.stringify(written[0])).not.toEqual(JSON.stringify(reordered[0]))
      expect(jsonRoot(written)).not.toEqual(jsonRoot(reordered))

      // ...while the canonical encoding gives one transaction one identity.
      expect(Array.from(canonicalEncoding(reordered[0]))).toEqual(
        Array.from(canonicalEncoding(written[0]))
      )
      expect(merkleRoot(transactionLeaves(reordered))).toEqual(
        merkleRoot(transactionLeaves(written))
      )
      expect(createBlock("0x00", 1, reordered).merkleRoot).toEqual(
        createBlock("0x00", 1, written).merkleRoot
      )
    })

    it("createBlock refuses a transaction the canonical encoder cannot represent", () => {
      expect(() =>
        createBlock("0x00", 1, [{ ...txs[0], amount: NaN }])
      ).toThrow(CanonicalEncodingError)
      expect(() =>
        createBlock("0x00", 1, [{ ...txs[0], memo: "free money" } as any])
      ).toThrow(/unknown field/)
      // JSON.stringify would have hashed both without complaint, and NaN would
      // have travelled over gossip as null.
      expect(JSON.stringify({ ...txs[0], amount: NaN })).toContain('"amount":null')
    })

    it("rejects unknown fields so they cannot ride along invisibly", () => {
      expect(() =>
        canonicalEncoding({ ...txs[0], fee: 1 } as any)
      ).toThrow(CanonicalEncodingError)
      // the five specified fields, payload included, are still accepted
      expect(() =>
        canonicalEncoding({ ...txs[0], payload: { note: "ok" } } as any)
      ).not.toThrow()
    })

    it("refuses an unsigned transaction", () => {
      const { signature, ...unsigned } = txs[0] as any
      expect(() => createBlock("0x00", 1, [unsigned])).toThrow(
        TransactionSignatureError
      )
      // the signature is excluded from the SIGNING bytes (it cannot be part of
      // its own preimage) but the leaf still commits to it — see tx-signature
      expect(Array.from(canonicalEncoding(txs[0]))).toEqual(
        Array.from(canonicalEncoding(unsigned))
      )
    })
  })

  describe("over gossip", () => {
    async function deliver(blk: Block, ports: [number, number]) {
      const [portA, portB] = ports
      // the three senders are funded, so every variant below is judged on its
      // leaves and not on whether the transfers are affordable
      const opening = funded([1, 2, 3])
      const nodeB = new Node(portB, [], genesis, [], opening)
      await wait(60)
      const nodeA = new Node(portA, [`ws://127.0.0.1:${portB}`], genesis, [], opening)

      // the header signature is over the HONEST header, which every variant
      // below shares, so only the recomputed leaves can tell them apart
      const sig = signBlock(honest, proposer)
      await wait(100)
      nodeA.broadcastBlock(blk, sig, proposer.publicKey)
      await wait(250)

      const tip = nodeB.tip
      nodeA.close(); nodeB.close()
      await wait(20)
      return tip
    }

    it("accepts an honest block", async () => {
      const tip = await deliver(honest, [9801, 9802])
      expect(tip.height).toBe(1)
      expect(tip.transactions.length).toBe(3)
    }, 4000)

    it("drops a block whose transaction carries an extra field and keeps its tip", async () => {
      const tampered: Block = {
        ...honest,
        transactions: [{ ...txs[0], memo: "free money" } as any, txs[1], txs[2]],
      }
      expect(blockHash(tampered)).toBe(blockHash(honest))

      const tip = await deliver(tampered, [9811, 9812])
      expect(tip.height).toBe(0)
      expect(blockHash(tip)).toBe(blockHash(genesis))
    }, 4000)

    it("drops a block committing to a NaN amount and keeps its tip", async () => {
      const tampered: Block = {
        ...honest,
        transactions: [{ ...txs[0], amount: NaN }, txs[1], txs[2]],
      }
      // NaN reaches the peer as null, which the encoder refuses as well
      const wire = JSON.parse(JSON.stringify(tampered)) as Block
      expect((wire.transactions[0] as any).amount).toBeNull()
      expect(() => transactionLeaves(wire.transactions)).toThrow(
        CanonicalEncodingError
      )

      const tip = await deliver(tampered, [9821, 9822])
      expect(tip.height).toBe(0)
      expect(blockHash(tip)).toBe(blockHash(genesis))
    }, 4000)
  })
})
