export type InvestorCommunicationMailStatus = "sent" | "not_sent" | "failed"

export type InvestorCommunicationRecipientGroup = "investor" | "deal_member"

export interface InvestorCommunicationRecipient {
  id: string
  displayName: string
  email: string
  groups: InvestorCommunicationRecipientGroup[]
  roleLabel: string
}

export interface InvestorCommunicationMailRow {
  id: string
  subject: string
  sendFrom: string
  /** Display label for recipients (e.g. “3 recipients”, single name). */
  sentTo: string
  /** Number of users the mail was sent to (from `recipient_users` JSON). */
  recipientCount: number
  /** Snapshot of recipients stored on the mail log row. */
  recipientUsers: InvestorCommunicationRecipient[]
  /** ISO timestamp or parseable date string. */
  sentAt: string
  status: InvestorCommunicationMailStatus
}
