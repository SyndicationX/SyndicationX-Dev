import { fetchMyProfile } from "@/modules/myaccount/accountApi"
import { mergeSessionUserDetails } from "@/modules/myaccount/sessionUser"
import {
  isDealSponsorSessionUser,
  isLeadSponsorSessionFlagKnown,
} from "./roleUtils"

/**
 * Older sessions predate `is_lead_sponsor`. Refresh once so Settings can show Billing
 * without requiring a new sign-in.
 */
export async function refreshLeadSponsorSessionIfNeeded(): Promise<boolean> {
  if (!isDealSponsorSessionUser() || isLeadSponsorSessionFlagKnown()) return false
  const user = await fetchMyProfile()
  if (!user) return false
  mergeSessionUserDetails(user)
  return true
}
