import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapSignFlowTemplateFieldsForInvestor,
  resolveSignFlowFieldTemplateAnchor,
} from "../src/services/esign/signflow.service.js";
import { PDFDocument } from "pdf-lib";
import {
  computePdfPageFingerprints,
  remapSignFlowFieldsToSigningPdf,
} from "../src/services/deal/esignPdfPageMap.service.js";
import {
  alignSignFlowRadioFieldSizeToChoiceBox,
  esignDocumentChoiceFieldSize,
  keepChoiceFieldsThroughPrefill,
  normalizeSignFlowChoiceFieldOptionNumbers,
  prependPdfBuffers,
  restoreFlattenedChoiceFields,
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

describe("questionnaire page hash placement", () => {
  it("keeps a field on its document page after answer pages are prepended", async () => {
    async function makePdf(label: string, pages: number) {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([600, 800]);
        page.drawText(`${label} page ${i + 1} body text`);
      }
      return Buffer.from(await doc.save());
    }

    const template = await makePdf("agreement", 2);
    const answers = await makePdf("answers", 2);
    const merged = await prependPdfBuffers(template, [answers]);
    const hashes = await computePdfPageFingerprints(template);
    const [field] = await remapSignFlowFieldsToSigningPdf(
      [
        {
          type: "signature",
          label: "Investor Signature",
          x: 12,
          y: 40,
          width: 30,
          height: 6,
          page: 2,
          templatePage: 2,
          pageHash: "stale-page-number-hash",
          recipientId: "rec_investor",
        },
      ],
      template,
      merged.buffer,
    );

    assert.equal(field?.page, 4);
    assert.equal(field?.pageHash, hashes[1]);
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

  it("keeps a radio group numbered across pages", () => {
    const fields = normalizeSignFlowChoiceFieldOptionNumbers([
      {
        type: "radio",
        label: "Option 1",
        x: 10,
        y: 80,
        width: 16,
        height: 3,
        page: 1,
        recipientId: "rec_1",
        radioGroupId: "rg_shared",
      },
      {
        type: "radio",
        label: "Option 2",
        x: 10,
        y: 90,
        width: 16,
        height: 3,
        page: 1,
        recipientId: "rec_1",
        radioGroupId: "rg_shared",
      },
      {
        type: "radio",
        label: "Option 1",
        x: 10,
        y: 2,
        width: 16,
        height: 3,
        page: 2,
        recipientId: "rec_1",
        radioGroupId: "rg_shared",
      },
    ]);

    assert.deepEqual(
      fields.map((field) => field.label),
      ["Option 1", "Option 2", "Option 3"],
    );
    assert.equal(fields[2]?.page, 2);
    assert.equal(fields[2]?.radioGroupId, "rg_shared");
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

  it("turns a flattened text field back into its radio or checkbox", () => {
    const restored = restoreFlattenedChoiceFields(
      [
        {
          type: "text",
          label: "Accredited",
          x: 12,
          y: 40,
          width: 30,
          height: 4,
          page: 3,
          recipientId: "rec_investor",
          radioGroupId: "grp-accredited",
          value: "Jane",
        },
        {
          type: "text",
          label: "Agree",
          x: 18,
          y: 55,
          width: 30,
          height: 4,
          page: 3,
          recipientId: "rec_investor",
        },
        {
          type: "text",
          label: "First Name",
          x: 20,
          y: 10,
          width: 30,
          height: 4,
          page: 1,
          recipientId: "rec_investor",
        },
      ],
      [
        {
          type: "radio",
          label: "Accredited",
          x: 12,
          y: 40,
          width: 2,
          height: 2,
          page: 1,
          recipientId: "rec_investor",
          radioGroupId: "grp-accredited",
        },
        {
          type: "checkbox",
          label: "Agree",
          x: 18,
          y: 55,
          width: 2,
          height: 2,
          page: 1,
          recipientId: "rec_investor",
        },
      ],
    );

    assert.equal(restored.changed, true);
    assert.equal(restored.fields[0]?.type, "radio");
    assert.equal(restored.fields[0]?.radioGroupId, "grp-accredited");
    assert.equal(restored.fields[1]?.type, "checkbox");
    assert.equal(restored.fields[1]?.width, 2);
    assert.equal(restored.fields[2]?.type, "text");
  });

  it("keeps radio and checkbox types that prefill rewrote as text", () => {
    const kept = keepChoiceFieldsThroughPrefill(
      [
        {
          type: "text",
          label: "Accredited",
          x: 1,
          y: 1,
          width: 40,
          height: 8,
          page: 2,
          recipientId: "rec_investor",
          value: "Jane",
        },
      ],
      [
        {
          type: "radio",
          label: "Accredited",
          x: 12,
          y: 40,
          width: 2,
          height: 2,
          page: 2,
          recipientId: "rec_investor",
          radioGroupId: "grp-accredited",
        },
      ],
    );
    assert.equal(kept[0]?.type, "radio");
    assert.equal(kept[0]?.radioGroupId, "grp-accredited");
    assert.equal(kept[0]?.x, 12);
    assert.equal(kept[0]?.width, 2);
  });
});
