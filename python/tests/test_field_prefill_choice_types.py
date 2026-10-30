import unittest

from app.models import PlacedField, PrefillContext, QuestionAnswer
from app.services.field_prefill import prefill_fields


def _field(field_type: str, label: str, value: str | None = None) -> PlacedField:
    return PlacedField(
        type=field_type,  # type: ignore[arg-type]
        label=label,
        x=10,
        y=20,
        width=8,
        height=4,
        page=1,
        recipient_id="rec_investor",
        value=value,
    )


class ChoiceFieldPrefillTests(unittest.TestCase):
    def test_radio_and_checkbox_keep_type_and_value(self) -> None:
        radio = _field("radio", "Accredited", "yes")
        checkbox = _field("checkbox", "Agree", "checked")
        text = _field("text", "First Name")
        fields, count = prefill_fields(
            [radio, checkbox, text],
            [QuestionAnswer(question_id="first_name", value="Jane")],
            PrefillContext(),
        )
        self.assertEqual(fields[0].type, "radio")
        self.assertEqual(fields[0].value, "yes")
        self.assertEqual(fields[0].x, 10)
        self.assertEqual(fields[1].type, "checkbox")
        self.assertEqual(fields[1].value, "checked")
        self.assertEqual(fields[2].type, "text")
        self.assertEqual(fields[2].value, "Jane")
        self.assertEqual(count, 1)

    def test_unknown_type_still_becomes_text(self) -> None:
        parsed = PlacedField(
            type="stamp",  # type: ignore[arg-type]
            label="Seal",
            x=1,
            y=1,
            width=4,
            height=4,
            page=1,
            recipient_id="rec_investor",
        )
        self.assertEqual(parsed.type, "text")


if __name__ == "__main__":
    unittest.main()
