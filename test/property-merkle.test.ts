import fc from "fast-check"
import {
  MERKLE_LEAF_TAG,
  MERKLE_NODE_TAG,
  MerkleProofStep,
  merkleLeafHash,
  merkleNodeHash,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from "../src/merkle"

/**
 * Merkle proofs (src/merkle.ts, merkleProof / verifyMerkleProof) and the
 * second-preimage separation of leaves from internal nodes.
 *
 *   proof verifies  <=>  the leaf is a member at that index of the tree
 *
 * Left to right: every member's proof verifies, for every size of tree
 * (including the odd widths that PROMOTE a node). Right to left: a non-member,
 * a member under another index's proof, a tampered proof and an internal node
 * presented as a leaf all fail.
 */
const RUNS = { numRuns: 200 }
const leafArb = fc.uint8Array({ minLength: 0, maxLength: 48 })
const listArb = fc.array(leafArb, { minLength: 1, maxLength: 17 })

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex")
}

function contains(list: Uint8Array[], item: Uint8Array): boolean {
  return list.some((l) => Buffer.from(l).equals(Buffer.from(item)))
}

describe("Merkle proof verifies <=> membership", () => {
  it("every member's proof verifies against the root", () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const root = merkleRoot(list)
        for (let i = 0; i < list.length; i++) {
          expect(verifyMerkleProof(root, list[i], merkleProof(list, i))).toBe(true)
        }
      }),
      RUNS
    )
  })

  it("a non-member never verifies under any member's proof", () => {
    fc.assert(
      fc.property(listArb, leafArb, (list, stranger) => {
        fc.pre(!contains(list, stranger))
        const root = merkleRoot(list)
        for (let i = 0; i < list.length; i++) {
          expect(verifyMerkleProof(root, stranger, merkleProof(list, i))).toBe(false)
        }
      }),
      RUNS
    )
  })

  it("a member does not verify under another index's proof unless the leaves are equal", () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const root = merkleRoot(list)
        for (let i = 0; i < list.length; i++) {
          for (let j = 0; j < list.length; j++) {
            if (i === j) continue
            const same = Buffer.from(list[i]).equals(Buffer.from(list[j]))
            const proofJ = merkleProof(list, j)
            const proofI = merkleProof(list, i)
            // identical leaf bytes at two indexes may have identical proofs
            // (a mirror-symmetric tree), so only unequal leaves are decisive
            if (!same) {
              const identicalProof =
                proofI.length === proofJ.length &&
                proofI.every((s, k) => s.side === proofJ[k].side && hex(s.sibling) === hex(proofJ[k].sibling))
              if (!identicalProof) expect(verifyMerkleProof(root, list[i], proofJ)).toBe(false)
            }
          }
        }
      }),
      { numRuns: 100 }
    )
  })

  it("the root of a different list never verifies a member's proof", () => {
    fc.assert(
      fc.property(listArb, leafArb, (list, extra) => {
        const other = [...list, extra]
        const root = merkleRoot(list)
        const otherRoot = merkleRoot(other)
        expect(otherRoot).not.toBe(root)
        for (let i = 0; i < list.length; i++) {
          expect(verifyMerkleProof(otherRoot, list[i], merkleProof(list, i))).toBe(false)
        }
      }),
      RUNS
    )
  })

  it("flipping a step's side, dropping a step or adding one breaks the proof", () => {
    fc.assert(
      fc.property(listArb.filter((l) => l.length >= 2), (list) => {
        const root = merkleRoot(list)
        for (let i = 0; i < list.length; i++) {
          const proof = merkleProof(list, i)
          if (proof.length === 0) continue
          const flipped: MerkleProofStep[] = proof.map((s, k) =>
            k === 0 ? { sibling: s.sibling, side: s.side === "left" ? "right" : "left" } : s
          )
          // a flipped side swaps the children: a different preimage, unless the
          // two children happen to be byte-identical (an all-equal pair)
          if (hex(proof[0].sibling) !== hex(merkleLeafHash(list[i]))) {
            expect(verifyMerkleProof(root, list[i], flipped)).toBe(false)
          }
          expect(verifyMerkleProof(root, list[i], proof.slice(1))).toBe(false)
          expect(verifyMerkleProof(root, list[i], [...proof, { sibling: new Uint8Array(32), side: "right" }])).toBe(false)
        }
      }),
      { numRuns: 100 }
    )
  })

  it("answers false, never throws, for malformed proofs", () => {
    const list = [new Uint8Array([1]), new Uint8Array([2])]
    const root = merkleRoot(list)
    expect(verifyMerkleProof(root, list[0], (null as unknown) as MerkleProofStep[])).toBe(false)
    expect(verifyMerkleProof(root, list[0], [{ sibling: new Uint8Array(31), side: "right" }])).toBe(false)
    expect(verifyMerkleProof(root, list[0], [{ sibling: merkleLeafHash(list[1]), side: "up" as "right" }])).toBe(false)
    expect(verifyMerkleProof((42 as unknown) as string, list[0], merkleProof(list, 0))).toBe(false)
    expect(() => merkleProof(list, 2)).toThrow(RangeError)
    expect(() => merkleProof(list, -1)).toThrow(RangeError)
    expect(() => merkleProof([], 0)).toThrow(RangeError)
  })

  it("a single leaf has an empty proof and the promoted leaf of an odd tree a shorter one", () => {
    expect(merkleProof([new Uint8Array([9])], 0)).toEqual([])
    const three = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
    // layer 0: [h1, h2, h3] -> layer 1: [n(h1,h2), h3 promoted] -> root n(n12, h3)
    expect(merkleProof(three, 0).length).toBe(2)
    expect(merkleProof(three, 2).length).toBe(1)
    expect(merkleProof(three, 2)[0].side).toBe("left")
  })
})

describe("Merkle second-preimage resistance: leaves and nodes are separated", () => {
  it("an internal node's preimage presented as a transaction is a different leaf", () => {
    fc.assert(
      fc.property(leafArb, leafArb, (a, b) => {
        const ha = merkleLeafHash(a)
        const hb = merkleLeafHash(b)
        // the bytes an untagged tree would hash to make the node (h(a) || h(b))
        const concat = new Uint8Array(64)
        concat.set(ha, 0)
        concat.set(hb, 32)
        // and the tagged node preimage itself (0x01 || h(a) || h(b))
        const tagged = new Uint8Array(65)
        tagged[0] = MERKLE_NODE_TAG
        tagged.set(concat, 1)
        const honest = merkleRoot([a, b])
        expect(merkleRoot([concat])).not.toBe(honest)
        expect(merkleRoot([tagged])).not.toBe(honest)
        expect(hex(merkleLeafHash(concat))).not.toBe(hex(merkleNodeHash(ha, hb)))
        // a proof cannot carry the forged leaf to the honest root either
        expect(verifyMerkleProof(honest, concat, [])).toBe(false)
        expect(verifyMerkleProof(honest, tagged, [])).toBe(false)
      }),
      RUNS
    )
  })

  it("the tags really are different bytes at offset 0 of the preimage", () => {
    expect(MERKLE_LEAF_TAG).not.toBe(MERKLE_NODE_TAG)
    expect(MERKLE_LEAF_TAG).toBe(0x00)
    expect(MERKLE_NODE_TAG).toBe(0x01)
  })

  it("appending a copy of the last leaf always changes the root (promotion, not duplication)", () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const padded = [...list, list[list.length - 1]]
        expect(merkleRoot(padded)).not.toBe(merkleRoot(list))
      }),
      RUNS
    )
  })

  it("a list of n leaves never shares a root with a list of a different length", () => {
    fc.assert(
      fc.property(listArb, fc.integer({ min: 1, max: 4 }), (list, drop) => {
        fc.pre(list.length > drop)
        expect(merkleRoot(list.slice(0, list.length - drop))).not.toBe(merkleRoot(list))
      }),
      RUNS
    )
  })
})
