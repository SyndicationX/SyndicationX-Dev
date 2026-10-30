import { fetchMyProfile } from "@/modules/myaccount/accountApi"

export const CO_SPONSOR_COMPANY_REQUIRED_EVENT = "cosponsor-company-required"

let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function flagFromProfile(user: Record<string, unknown> | null): boolean {
  const flag = user?.coSponsorNeedsCompany ?? user?.co_sponsor_needs_company
  return flag === true || flag === "true"
}

/** Whether the signed-in co-sponsor still has no company. */
export async function loadCoSponsorNeedsCompany(
  force = false,
): Promise<boolean> {
  if (!force && cached !== null) return cached
  if (!force && inflight) return inflight
  inflight = fetchMyProfile()
    .then((user) => {
      cached = flagFromProfile(user)
      return cached
    })
    .catch(() => {
      cached = false
      return false
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** False when this person cannot open a deal until they create a company. */
export async function coSponsorMayOpenDeal(): Promise<boolean> {
  const needsCompany = await loadCoSponsorNeedsCompany()
  if (!needsCompany) return true
  window.dispatchEvent(new Event(CO_SPONSOR_COMPANY_REQUIRED_EVENT))
  return false
}
