/**
 * Money is integer paisa (bigint). Never floats. 100 paisa = 1 PKR.
 */
export type Paisa = bigint

export function assertPaisa(v: bigint): Paisa {
  if (typeof v !== 'bigint' || v < 0n)
    throw new RangeError('Money must be a non-negative bigint (paisa)')
  return v
}

/** Round up to a whole rupee. */
export function ceilToRupee(p: Paisa): Paisa {
  assertPaisa(p)
  return ((p + 99n) / 100n) * 100n
}

/** 20% advance rounded UP to a whole rupee: ((total + 499) / 500) * 100. Capped at total. */
export function depositFor(total: Paisa): Paisa {
  assertPaisa(total)
  const d = ((total + 499n) / 500n) * 100n
  return d > total ? total : d
}

/**
 * Split `total` across `weights` using the largest-remainder method.
 * The parts always add up to exactly `total`.
 */
export function splitExact(total: Paisa, weights: bigint[]): Paisa[] {
  assertPaisa(total)
  if (weights.length === 0) throw new RangeError('weights must not be empty')
  if (weights.some((w) => w < 0n)) throw new RangeError('weights must be >= 0')
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum === 0n) {
    if (total !== 0n) throw new RangeError('cannot split a non-zero total across zero weights')
    return weights.map(() => 0n)
  }
  const floors = weights.map((w) => (total * w) / sum)
  const rems = weights.map((w, i) => ({ i, r: (total * w) % sum }))
  let left = total - floors.reduce((a, b) => a + b, 0n)
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of rems) {
    if (left <= 0n) break
    floors[i] += 1n
    left -= 1n
  }
  return floors
}

/** Display only, e.g. "Rs 1,500". Never use for calculation. */
export function formatPKR(p: Paisa): string {
  const rupees = p / 100n
  const paisa = p % 100n
  const r = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return paisa === 0n ? `Rs ${r}` : `Rs ${r}.${paisa.toString().padStart(2, '0')}`
}
