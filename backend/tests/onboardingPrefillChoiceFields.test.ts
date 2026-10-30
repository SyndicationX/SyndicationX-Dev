import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SignFlowField } from "../src/services/esign/signflow.service.js";
import {
  mergePythonPrefillFields,
  pythonPrefillFieldType,
} from "../src/services/onboarding/onboardingFieldsPython.service.js";

process.env.JWT_SECRET_KEY =
  process.env.JWT_SECRET_KEY ??
  "test-jwt-secret-key-at-least-32-chars-long!!";

function field(partial: SignFlowField): SignFlowField {
  return partial;
}

describe("onboarding prefill choice fields", () => {
  it("sends radio and checkbox as themselves", () => {
    assert.equal(pythonPrefillFieldType("radio"), "radio");
    assert.equal(pythonPrefillFieldType("checkbox"), "checkbox");
    assert.equal(pythonPrefillFieldType("RADIO"), "radio");
  });

  it("keeps signature, date, text, and initials mappings", () => {
    assert.equal(pythonPrefillFieldType("signature"), "signature");
    assert.equal(pythonPrefillFieldType("text"), "text");
    assert.equal(pythonPrefillFieldType("date"), "date");
    assert.equal(pythonPrefillFieldType("date_signed"), "date");
    assert.equal(pythonPrefillFieldType("initial"), "initials");
    assert.equal(pythonPrefillFieldType("initials"), "initials");
  });

  it("keeps radio groups and checkbox selections when prefill returns text", () => {
    const radio: SignFlowField = field({
      type: "radio",
      label: "Accredited",
      x: 12,
      y: 40,
      width: 3,
      height: 3,
      page: 2,
      recipientId: "rec_investor",
      radioGroupId: "grp-accredited",
      value: "yes",
    });
    const checkbox: SignFlowField = field({
      type: "checkbox",
      label: "Agree",
      x: 18,
      y: 55,
      width: 3,
      height: 3,
      page: 2,
      recipientId: "rec_investor",
      value: "checked",
    });
    const name: SignFlowField = field({
      type: "text",
      label: "First Name",
      x: 20,
      y: 10,
      width: 30,
      height: 4,
      page: 1,
      recipientId: "rec_investor",
    });

    const merged = mergePythonPrefillFields(
      [radio, checkbox, name],
      [
        {
          type: "text",
          label: "Accredited",
          x: 1,
          y: 1,
          width: 40,
          height: 8,
          page: 9,
          recipient_id: "rec_other",
          recipient_role: "investor",
          value: "Jane",
        },
        {
          type: "text",
          label: "Agree",
          x: 1,
          y: 1,
          width: 40,
          height: 8,
          page: 9,
          recipient_id: "rec_other",
          recipient_role: "investor",
          value: "on",
        },
        {
          type: "text",
          label: "First Name",
          x: 20,
          y: 10,
          width: 30,
          height: 4,
          page: 1,
          recipient_id: "rec_investor",
          recipient_role: "investor",
          value: "Jane",
        },
      ],
    );

    assert.equal(merged[0].type, "radio");
    assert.equal(merged[0].radioGroupId, "grp-accredited");
    assert.equal(merged[0].value, "yes");
    assert.equal(merged[0].x, 12);
    assert.equal(merged[0].page, 2);
    assert.equal(merged[1].type, "checkbox");
    assert.equal(merged[1].value, "checked");
    assert.equal(merged[1].x, 18);
    assert.equal(merged[2].type, "text");
    assert.equal(merged[2].value, "Jane");
  });

  it("still prefills a date field", () => {
    const date: SignFlowField = {
      type: "date",
      label: "Date Signed",
      x: 10,
      y: 20,
      width: 20,
      height: 4,
      page: 3,
      recipientId: "rec_investor",
    };
    const merged = mergePythonPrefillFields(
      [date],
      [
        {
          type: "text",
          label: "Date Signed",
          x: 10,
          y: 20,
          width: 20,
          height: 4,
          page: 3,
          recipient_id: "rec_investor",
          recipient_role: "investor",
          value: "19-Oct-2026",
        },
      ],
    );
    assert.equal(merged[0].value, "19-Oct-2026");
    assert.equal(merged[0].page, 3);
  });
});
