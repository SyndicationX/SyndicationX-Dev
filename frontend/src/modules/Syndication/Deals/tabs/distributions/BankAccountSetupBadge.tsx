import type { BankAccountSetupStatus } from "@/modules/Investing/api/stripeInvestorPaymentsApi"

const TITLE =
  "Whether bank account details are on file. This does not mean the account has been verified or that ACH processing is enabled."

export function BankAccountSetupBadge({
  status,
}: {
  status: BankAccountSetupStatus | undefined
}) {
  const setUp = status === "set_up"
  return (
    <span
      className={`deal_dist_ach_badge deal_dist_ach_badge--${setUp ? "success" : "neutral"}`}
      title={TITLE}
    >
      {setUp ? "Set Up" : "Not Set Up"}
    </span>
  )
}

export function bankAccountSetupLookup(
  lines: { investmentId: string; status: BankAccountSetupStatus }[],
): Map<string, BankAccountSetupStatus> {
  const map = new Map<string, BankAccountSetupStatus>()
  for (const line of lines) {
    const id = line.investmentId.trim().toLowerCase()
    if (id) map.set(id, line.status)
  }
  return map
}
