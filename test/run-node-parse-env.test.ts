import { parseValidators, parseGenesisBalances } from "../examples/run-node"

describe("examples/run-node env parsers", () => {
  describe("parseValidators", () => {
    it("accepts a single valid validator entry", () => {
      const hex = "a".repeat(64) // 64 hex chars
      const res = parseValidators(`${hex}:10`)
      expect(res.length).toBe(1)
      expect(res[0].publicKey).toBe(hex)
      expect(res[0].stake).toBe(10)
    })

    it("rejects non-hex or wrong-length keys", () => {
      const short = "b".repeat(62)
      const nonhex = "g".repeat(64)
      expect(parseValidators(`${short}:5`)).toEqual([])
      expect(parseValidators(`${nonhex}:5`)).toEqual([])
    })

    it("rejects entries without a stake or with bad stake", () => {
      const hex = "c".repeat(64)
      expect(parseValidators(`${hex}`)).toEqual([])
      expect(parseValidators(`${hex}:notanumber`)).toEqual([])
      expect(parseValidators(`${hex}:-1`)).toEqual([])
    })
  })

  describe("parseGenesisBalances", () => {
    it("accepts a single valid account entry", () => {
      const hex = "d".repeat(64)
      const res = parseGenesisBalances(`${hex}:100`)
      expect(res[hex]).toBe(100)
    })

    it("rejects non-hex or wrong-length accounts", () => {
      const short = "e".repeat(60)
      const nonhex = "z".repeat(64)
      expect(parseGenesisBalances(`${short}:1`)).toEqual({})
      expect(parseGenesisBalances(`${nonhex}:1`)).toEqual({})
    })

    it("rejects entries without an amount or with bad amount", () => {
      const hex = "f".repeat(64)
      expect(parseGenesisBalances(`${hex}`)).toEqual({})
      expect(parseGenesisBalances(`${hex}:notanumber`)).toEqual({})
      expect(parseGenesisBalances(`${hex}:-5`)).toEqual({})
    })
  })
})
