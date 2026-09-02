import {
  canonicalEncoding,
  canonicalBlockEncoding,
  stableStringify,
  CanonicalBlockHeader,
  CanonicalEncodingError,
  MAX_CANONICAL_UINT,
} from "../src/coding/serialize"

function hex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("")
}

const validTx = { sender: "s", recipient: "r", amount: 42, nonce: 7 }

describe("canonical encoding rejects ambiguous inputs", () => {
  describe("uint64 fields", () => {
    it("rejects a fractional amount that would encode like an integer", () => {
      // Before validation, 1 and 1.5 produced the SAME eight bytes, so one
      // signature was valid for two different transactions.
      expect(() =>
        canonicalEncoding({ ...validTx, amount: 1.5 } as any)
      ).toThrow(CanonicalEncodingError)
      expect(hex(canonicalEncoding({ ...validTx, amount: 1 } as any))).toEqual(
        hex(canonicalEncoding({ ...validTx, amount: 1 } as any))
      )
    })

    it("rejects a negative amount that would collide with max uint64", () => {
      expect(() => canonicalEncoding({ ...validTx, amount: -1 } as any)).toThrow(
        /must not be negative/
      )
    })

    it("rejects amounts above 2**53 - 1, which a number cannot hold exactly", () => {
      expect(() =>
        canonicalEncoding({ ...validTx, amount: 2 ** 53 } as any)
      ).toThrow(/2\*\*53/)
      expect(() =>
        canonicalEncoding({ ...validTx, amount: MAX_CANONICAL_UINT } as any)
      ).not.toThrow()
    })

    it("rejects NaN, Infinity and non-number nonces", () => {
      expect(() => canonicalEncoding({ ...validTx, nonce: NaN } as any)).toThrow()
      expect(() =>
        canonicalEncoding({ ...validTx, nonce: Infinity } as any)
      ).toThrow()
      expect(() => canonicalEncoding({ ...validTx, nonce: "7" } as any)).toThrow(
        /must be a number/
      )
      expect(() =>
        canonicalEncoding({ sender: "s", recipient: "r", amount: 1 } as any)
      ).toThrow(/nonce/)
    })

    it("rejects a fractional block timestamp or height", () => {
      const header: CanonicalBlockHeader = {
        parentHash: "p",
        height: 42,
        timestamp: 7,
        merkleRoot: "m",
      }
      expect(() =>
        canonicalBlockEncoding({ ...header, timestamp: 7.25 })
      ).toThrow(CanonicalEncodingError)
      expect(() => canonicalBlockEncoding({ ...header, height: -1 })).toThrow()
    })
  })

  describe("length-prefixed fields", () => {
    it("throws instead of writing a length modulo 65536", () => {
      // 65536 bytes would previously have been framed with length 0 while the
      // full bytes were still emitted: the framing stopped being injective.
      const long = "a".repeat(0x10000)
      expect(() =>
        canonicalEncoding({ ...validTx, sender: long } as any)
      ).toThrow(/length prefix/)
      const justFits = "a".repeat(0xffff)
      expect(() =>
        canonicalEncoding({ ...validTx, sender: justFits } as any)
      ).not.toThrow()
    })

    it("counts UTF-8 bytes, not characters, when bounding a field", () => {
      // Each of these is 3 UTF-8 bytes, so 22000 of them overflow the prefix.
      const wide = "中".repeat(22000)
      expect(() =>
        canonicalEncoding({ ...validTx, recipient: wide } as any)
      ).toThrow(/length prefix/)
    })

    it("throws when a payload serializes to more than 65535 bytes", () => {
      const payload = { note: "x".repeat(70000) }
      expect(() => canonicalEncoding({ ...validTx, payload } as any)).toThrow(
        /length prefix/
      )
    })
  })

  describe("missing or mistyped string fields", () => {
    it("rejects a missing sender instead of signing the string \"undefined\"", () => {
      expect(() =>
        canonicalEncoding({ recipient: "r", amount: 1, nonce: 1 } as any)
      ).toThrow(/tx.sender must be a string/)
    })

    it("rejects a missing recipient", () => {
      expect(() =>
        canonicalEncoding({ sender: "s", amount: 1, nonce: 1 } as any)
      ).toThrow(/tx.recipient must be a string/)
    })

    it("rejects a non-string sender", () => {
      expect(() =>
        canonicalEncoding({ ...validTx, sender: 12 } as any)
      ).toThrow(/tx.sender must be a string/)
      expect(() =>
        canonicalEncoding({ ...validTx, sender: null } as any)
      ).toThrow(/tx.sender must be a string/)
    })

    it("rejects a missing parentHash or merkleRoot in a block header", () => {
      expect(() =>
        canonicalBlockEncoding({ height: 1, timestamp: 1, merkleRoot: "m" } as any)
      ).toThrow(/header.parentHash must be a string/)
      expect(() =>
        canonicalBlockEncoding({ parentHash: "p", height: 1, timestamp: 1 } as any)
      ).toThrow(/header.merkleRoot must be a string/)
    })

    it("rejects a proposer public key that is not raw bytes", () => {
      const header = {
        parentHash: "p",
        height: 1,
        timestamp: 1,
        merkleRoot: "m",
        proposerPublicKey: "deadbeef",
      }
      expect(() => canonicalBlockEncoding(header as any)).toThrow(
        /proposerPublicKey must be a Uint8Array/
      )
    })

    it("rejects a transaction that is not an object at all", () => {
      expect(() => canonicalEncoding(undefined as any)).toThrow()
      expect(() => canonicalEncoding("tx" as any)).toThrow()
    })
  })

  describe("stableStringify", () => {
    it("still sorts keys and produces one string per value", () => {
      expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toEqual(
        '{"a":[2,{"c":3,"d":4}],"b":1}'
      )
    })

    it("throws on values JSON cannot round-trip", () => {
      expect(() => stableStringify({ a: undefined })).toThrow(/undefined/)
      expect(() => stableStringify({ a: NaN })).toThrow(/finite/)
      expect(() => stableStringify({ a: Infinity })).toThrow(/finite/)
      expect(() => stableStringify([1, undefined])).toThrow(/undefined/)
      expect(() => stableStringify({ a: () => 1 })).toThrow(/function/)
      expect(() => stableStringify({ a: Symbol("s") })).toThrow(/symbol/)
      expect(() => stableStringify({ a: BigInt(1) })).toThrow(/bigint/)
    })

    it("names the path of the offending value", () => {
      expect(() => stableStringify({ outer: { inner: undefined } })).toThrow(
        /payload\.outer\.inner/
      )
    })
  })

  describe("the wire format for valid inputs is unchanged", () => {
    it("reproduces the byte-for-byte transaction vector", () => {
      // "tx:" | len(1) "s" | len(1) "r" | amount 42 | nonce 7 | payload len 0
      expect(hex(canonicalEncoding(validTx as any))).toEqual(
        "74783a" +
          "0001" + "73" +
          "0001" + "72" +
          "000000000000002a" +
          "0000000000000007" +
          "0000"
      )
    })

    it("reproduces the byte-for-byte block header vector", () => {
      const header: CanonicalBlockHeader = {
        parentHash: "p",
        height: 42,
        timestamp: 7,
        merkleRoot: "m",
      }
      expect(hex(canonicalBlockEncoding(header))).toEqual(
        "626c6b3a" +
          "0001" + "70" +
          "000000000000002a" +
          "0000000000000007" +
          "0001" + "6d" +
          "0000"
      )
    })

    it("still encodes the signing vectors used by the existing signing tests", () => {
      const tx = {
        sender: "alice",
        recipient: "bob",
        amount: 100,
        nonce: 1,
        payload: { note: "hello" },
      }
      const bytes = canonicalEncoding(tx as any)
      const asText = new TextDecoder().decode(bytes)
      expect(asText.startsWith("tx:")).toBe(true)
      expect(asText).toContain("alice")
      expect(asText).toContain('{"note":"hello"}')
      // 3 prefix + 2+5 sender + 2+3 recipient + 8 + 8 + 2 + 16 payload
      expect(bytes.length).toBe(3 + 7 + 5 + 8 + 8 + 2 + 16)

      const pk = new Uint8Array(32)
      pk[0] = 9
      const header: CanonicalBlockHeader = {
        parentHash: "0000",
        height: 5,
        timestamp: 1234567890,
        merkleRoot: "abcd",
        proposerPublicKey: pk,
      }
      // 4 prefix + 2+4 parentHash + 8 + 8 + 2+4 merkleRoot + 2+32 key
      expect(canonicalBlockEncoding(header).length).toBe(66)
    })

    it("keeps zero a valid amount and an empty string a valid field", () => {
      expect(() =>
        canonicalEncoding({ sender: "", recipient: "", amount: 0, nonce: 0 } as any)
      ).not.toThrow()
    })
  })
})
