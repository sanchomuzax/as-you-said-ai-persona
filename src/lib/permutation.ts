/**
 * Balanced cyclic rotations: every option appears exactly once in every position.
 * All n rotations are always generated — a subset cannot be balanced, and the
 * position-bias mitigation depends on this invariant.
 */
export function balancedRotations(n: number): number[][] {
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, i) => (i + r) % n)
  )
}

export function applyPermutation<T>(options: readonly T[], rotation: readonly number[]): T[] {
  return rotation.map((idx) => {
    const v = options[idx]
    if (v === undefined) throw new Error(`Invalid rotation index ${idx}`)
    return v
  })
}

/** Neutral letter labels (A, B, C…) — never model names or numbers. */
export function labelFor(position: number): string {
  if (position < 0 || position > 25) throw new Error(`Label position out of range: ${position}`)
  return String.fromCharCode(65 + position)
}
