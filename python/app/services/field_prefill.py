"""Auto-populate field values from investor profile and questionnaire answers."""

from datetime import datetime

from app.models import PlacedField, PrefillContext, QuestionAnswer
from app.services.field_definitions import (
    COMPUTED_DATE_KEYS,
    COMPUTED_FULL_NAME_KEYS,
    COMPUTED_TITLE_KEYS,
    FIELD_KEY_TO_QUESTION_ID,
)


def _normalize_key(raw: str) -> str:
    return " ".join(str(raw or "").strip().lower().replace("_", " ").split())


def _answers_map(answers: list[QuestionAnswer]) -> dict[str, str]:
    return {a.question_id.strip(): a.value.strip() for a in answers if a.value.strip()}


def _format_phone(value: str) -> str:
    digits = "".join(c for c in value if c.isdigit())
    if len(digits) == 10:
        return f"+1 ({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
    return value


def _format_ssn(value: str) -> str:
    digits = "".join(c for c in value if c.isdigit())[:9]
    if len(digits) == 9:
        return f"{digits[:3]}-{digits[3:5]}-{digits[5:]}"
    return value


def _resolve_full_name(answers: dict[str, str], fallback: str | None) -> str:
    first = answers.get("first_name", "").strip()
    last = answers.get("last_name", "").strip()
    combined = f"{first} {last}".strip()
    if combined:
        return combined
    return (fallback or "").strip()


def _resolve_value_for_field(
    field: PlacedField,
    answers: dict[str, str],
    context: PrefillContext,
) -> str | None:
    if field.type not in ("text", "date"):
        return None

    key = _normalize_key(field.label)

    if key in COMPUTED_FULL_NAME_KEYS:
        val = _resolve_full_name(answers, context.member_display_name)
        return val or None

    if key in COMPUTED_DATE_KEYS:
        # Same DD-MMM-YYYY shape as the Node prefill. Sent as text so the signer can edit it.
        return datetime.now().strftime("%d-%b-%Y")

    if key in COMPUTED_TITLE_KEYS:
        return answers.get("entity_signer_title") or answers.get("title") or None

    if key in ("email", "email address"):
        return context.member_email or answers.get("email") or None

    if key in (
        "investment amount",
        "commitment amount",
        "amount",
        "subscription amount",
        "aggregate subscription amount",
        "total subscription amount",
        "subscription price",
    ):
        return (
            context.subscription_amount
            or context.investment_amount
            or answers.get("investment_amount")
            or None
        )

    if key in (
        "unit amount",
        "price per unit",
        "unit price",
        "purchase price per unit",
    ):
        return context.unit_amount or None

    if key in (
        "number of units",
        "no. of units",
        "no of units",
        "units",
        "units subscribed",
        "units purchased",
    ):
        return context.unit_count or None

    question_id = FIELD_KEY_TO_QUESTION_ID.get(key) or key.replace(" ", "_")
    raw = answers.get(question_id, "")
    if not raw:
        return None

    if "phone" in key or question_id == "telephone":
        return _format_phone(raw)
    if key == "ssn" or question_id == "social_security_number":
        return _format_ssn(raw)

    return raw


def prefill_fields(
    fields: list[PlacedField],
    answers: list[QuestionAnswer],
    context: PrefillContext,
) -> tuple[list[PlacedField], int]:
    """Apply questionnaire/profile data to placed text/date fields."""
    answer_map = _answers_map(answers)
    prefilled_count = 0
    result: list[PlacedField] = []

    for field in fields:
        if field.type in ("radio", "checkbox"):
            result.append(field)
            continue
        value = _resolve_value_for_field(field, answer_map, context)
        if value:
            prefilled_count += 1
            updates: dict[str, str] = {"value": value}
            if _normalize_key(field.label) in COMPUTED_DATE_KEYS:
                updates["type"] = "text"
            result.append(field.model_copy(update=updates))
        else:
            result.append(field)

    return result, prefilled_count
