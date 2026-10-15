import { Lock } from "lucide-react"
import "./redacted-pill.css"

const REDACTED_DOT_COUNT = 7

/** Soft grey lock pill for an email or phone the API has masked. */
export function RedactedPill() {
  return (
    <span className="pii_redacted_pill" title="Hidden" aria-label="redacted">
      <Lock size={12} strokeWidth={2.25} aria-hidden />
      <span className="pii_redacted_dots" aria-hidden>
        {Array.from({ length: REDACTED_DOT_COUNT }, (_, index) => (
          <span key={index} className="pii_redacted_dot" />
        ))}
      </span>
    </span>
  )
}
