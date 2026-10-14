import type { FeedbackItem } from "./types"

export function feedbackLocationLabel(item: Pick<FeedbackItem, "pageLabel" | "subPageLabel">): string {
  const page = item.pageLabel.trim() || "this page"
  const sub = item.subPageLabel.trim()
  return sub ? `${page} → ${sub}` : page
}
