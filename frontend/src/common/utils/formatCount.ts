const COUNT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

/** Whole numbers with thousands separators, e.g. 1234 → "1,234". */
export function formatCount(value: number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return "0"
  return COUNT_FORMAT.format(n)
}
