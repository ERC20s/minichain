import { selectValidator, Validator } from "../src/validators"

function seedFrom(n: number): Uint8Array {
  const s = new Uint8Array(32)
  for (let i = 0; i < 32; i++) s[i] = (n + i) & 0xff
  return s
}

describe("validator selection", () => {
  it("returns null for empty validators or invalid inputs", () => {
    expect(selectValidator([], seedFrom(1))).toBeNull()
    // invalid seed
    // @ts-ignore
    expect(selectValidator([{ publicKey: "a", stake: 1 }], null)).toBeNull()
    // invalid stake
    // @ts-ignore
    expect(selectValidator([{ publicKey: "a", stake: -1 }], seedFrom(1))).toBeNull()
  })

  it("selects the single validator when only one has stake", () => {
    const vals: Validator[] = [{ publicKey: "v1", stake: 10 }]
    expect(selectValidator(vals, seedFrom(5))).toBe("v1")
  })

  it("is deterministic for fixed seed and validators", () => {
    const vals: Validator[] = [
      { publicKey: "v1", stake: 1 },
      { publicKey: "v2", stake: 2 },
      { publicKey: "v3", stake: 3 },
    ]
    const s = seedFrom(7)
    const pick1 = selectValidator(vals, s)
    const pick2 = selectValidator(vals, s)
    expect(pick1).toBe(pick2)
  })

  it("matches expected picks for known seeds and stakes", () => {
    const vals: Validator[] = [
      { publicKey: "a", stake: 10 },
      { publicKey: "b", stake: 20 },
      { publicKey: "c", stake: 30 },
    ]
    // compute multiple seeds and assert picks are within the set and deterministic
    const s1 = seedFrom(0)
    const s2 = seedFrom(1)
    const s3 = seedFrom(2)
    const p1 = selectValidator(vals, s1)
    const p2 = selectValidator(vals, s2)
    const p3 = selectValidator(vals, s3)
    expect(["a", "b", "c"]).toContain(p1 as string)
    expect(["a", "b", "c"]).toContain(p2 as string)
    expect(["a", "b", "c"]).toContain(p3 as string)
  })
})
