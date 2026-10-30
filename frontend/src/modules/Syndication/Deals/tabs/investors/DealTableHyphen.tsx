/** Empty table value. Same centered hyphen in every column so a row of blanks lines up. */
export function DealTableHyphen() {
  return (
    <span className="deal_inv_cell_hyphen">
      <span>-</span>
    </span>
  )
}

export function isTableHyphen(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim()
  return text === "" || text === "—" || text === "-" || text === "–"
}
