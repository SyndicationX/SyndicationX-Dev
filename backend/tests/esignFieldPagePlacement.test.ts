import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapSignFlowTemplateFieldsForInvestor,
  resolveSignFlowFieldTemplateAnchor,
} from "../src/services/esign/signflow.service.js";
import {
  alignSignFlowRadioFieldSizeToChoiceBox,
  esignDocumentChoiceFieldSize,
  normalizeSignFlowChoiceFieldOptionNumbers,
} from "../src/services/deal/esignPdfMerge.service.js";

process.env.JWT_SECRET_KEY =
  process.env.JWT_SECRET_KEY ??
  "test-jwt-secret-key-at-least-32-chars-long!!";

describe("signflow field page anchors", () => {
  it("follows the live page when the sponsor moves a field to another page", () => {
    const anchor = resolveSignFlowFieldTemplateAnchor({
      page: 2,
      templatePage: 1,
      pageHash: "hash-of-page-1",
    });

    assert.equal(anchor.templatePage, 2);
    assert.equal(anchor.pageHash, undefined);
  });

  it("keeps the anchor hash for a field that stayed on its page", () => {
    const anchor = resolveSignFlowFieldTemplateAnchor({
      page: 2,
      templatePage: 2,
      pageHash: "hash-of-page-2",
    });

    assert.equal(anchor.templatePage, 2);
    assert.equal(anchor.pageHash, "hash-of-page-2");
  });

  it("copies an investor field onto the page it was placed on", () => {
    const [field] = mapSignFlowTemplateFieldsForInvestor(
      {
        id: "doc_1",
        recipients: [{ id: "rec_investor", role: "investor" }],
        fields: [
          {
            type: "signature",
            label: "Investor Signature",
            x: 12,
            y: 40,
            width: 30,
            height: 6,
            page: 2,
            recipientId: "rec_investor",
            // Stale annotations echoed back by SignFlow after the move.
            templatePage: 1,
            pageHash: "hash-of-page-1",
          },
        ],
      },
      "rec_investor",
    );

    assert.equal(field?.page, 2);
    assert.equal(field?.templatePage, 2);
    assert.equal(field?.pageHash, undefined);
  });
});

describe("signflow choice field sizing", () => {
  it("shrinks radio fields to an existing compact checkbox size", () => {
    const compactCheckbox = {
      type: "checkbox",
      width: 1,
      height: 1,
      page: 1,
    };
    const text = { type: "text", width: 25, height: 5, page: 1 };

    const [radio, unchangedCheckbox, unchangedText] =
      alignSignFlowRadioFieldSizeToChoiceBox([
        { type: "radio", width: 20, height: 20, page: 1 },
        compactCheckbox,
        text,
      ]);

    assert.equal(radio?.width, 1);
    assert.equal(radio?.height, 1);
    assert.equal(unchangedCheckbox, compactCheckbox);
    assert.equal(unchangedText, text);
  });

  it("shrinks checkbox fields without changing other field types", () => {
    const text = { type: "text", width: 25, height: 5, page: 1 };

    const [checkbox, unchangedText] = alignSignFlowRadioFieldSizeToChoiceBox([
      { type: "checkbox", width: 20, height: 20, page: 1 },
      text,
    ]);

    assert.deepEqual(
      { width: checkbox?.width, height: checkbox?.height },
      esignDocumentChoiceFieldSize(),
    );
    assert.equal(unchangedText, text);
  });

  it("keeps radio and checkbox fields the same size", () => {
    const [radio, checkbox] = alignSignFlowRadioFieldSizeToChoiceBox([
      { type: "radio", width: 20, height: 20, page: 1 },
      { type: "checkbox", width: 18, height: 18, page: 1 },
    ]);

    assert.deepEqual(
      { width: radio?.width, height: radio?.height },
      { width: checkbox?.width, height: checkbox?.height },
    );
  });

  it("uses the compact default when no checkbox is present", () => {
    const [radio] = alignSignFlowRadioFieldSizeToChoiceBox([
      { type: "radio", width: 20, height: 20, page: 1 },
    ]);

    assert.deepEqual(
      { width: radio?.width, height: radio?.height },
      esignDocumentChoiceFieldSize(),
    );
  });
});

describe("signflow choice field numbering", () => {
  it("keeps separate radio stacks numbered independently", () => {
    const fields = normalizeSignFlowChoiceFieldOptionNumbers([
      { type: "radio", label: "Radio 1", x: 10, y: 10, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "radio", label: "Radio 2", x: 10, y: 30, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "radio", label: "Radio 3", x: 44, y: 10, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "radio", label: "Radio 4", x: 10, y: 50, width: 2, height: 2, page: 1, recipientId: "rec_1" },
    ]);

    assert.deepEqual(
      fields.map((field) => field.label),
      ["Radio 1", "Radio 2", "Radio 1", "Radio 3"],
    );
  });

  it("keeps separate checkbox stacks numbered independently", () => {
    const fields = normalizeSignFlowChoiceFieldOptionNumbers([
      { type: "checkbox", label: "Checkbox 1", x: 10, y: 10, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "checkbox", label: "Checkbox 2", x: 10, y: 30, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "checkbox", label: "Checkbox 1", x: 44, y: 10, width: 2, height: 2, page: 1, recipientId: "rec_1" },
      { type: "checkbox", label: "Checkbox 4", x: 10, y: 50, width: 2, height: 2, page: 1, recipientId: "rec_1" },
    ]);

    assert.deepEqual(
      fields.map((field) => field.label),
      ["Checkbox 1", "Checkbox 2", "Checkbox 1", "Checkbox 3"],
    );
  });
});
