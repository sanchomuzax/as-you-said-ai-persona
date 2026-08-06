import { describe, it, expect } from 'vitest'
import { balancedRotations, applyPermutation, labelFor } from '../src/lib/permutation.js'

describe('balancedRotations', () => {
  it('returns n cyclic rotations for n options', () => {
    const rots = balancedRotations(3)
    expect(rots).toEqual([
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1]
    ])
  })

  it('each option index appears exactly once in every position', () => {
    const n = 5
    const rots = balancedRotations(n)
    for (let pos = 0; pos < n; pos++) {
      const seen = new Set(rots.map((r) => r[pos]))
      expect(seen.size).toBe(n)
    }
  })

  it('always generates all n rotations — a subset cannot be balanced', () => {
    expect(balancedRotations(6)).toHaveLength(6)
  })

  it('returns single identity rotation for 1 option', () => {
    expect(balancedRotations(1)).toEqual([[0]])
  })
})

describe('applyPermutation', () => {
  it('reorders options according to the rotation', () => {
    expect(applyPermutation(['x', 'y', 'z'], [2, 0, 1])).toEqual(['z', 'x', 'y'])
  })

  it('does not mutate the input array', () => {
    const input = ['a', 'b']
    applyPermutation(input, [1, 0])
    expect(input).toEqual(['a', 'b'])
  })
})

describe('labelFor', () => {
  it('produces neutral letter labels', () => {
    expect(labelFor(0)).toBe('A')
    expect(labelFor(25)).toBe('Z')
  })
})
