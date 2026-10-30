import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID,
  assignAlternateSignatureFields,
  signatureNameScore,
} from "../src/services/deal/esignAlternateSignature.service.js";
import {
  applyEditableSigningDatePrefill,
  isEditableSigningDateField,
} from "../src/services/deal/investorQuestionnaireEsignPrefill.service.js";
import type { SignFlowField } from "../src/services/esign/signflow.service.js";

process.env.JWT_SECRET_KEY =
  process.env.JWT_SECRET_KEY ??
  "test-jwt-secret-key-at-least-32-chars-long!!";

function field(partial: SignFlowField): SignFlowField {
  return partial;
}

const sponsor = "rec_sponsor";

describe("alternate signature lines", () => {
  it("matches a short first name to the printed name", () => {
    assert.ok(
      signatureNameScore("Douglas J Chupella", "Doug Chupella") >
        signatureNameScore("Sonja Kuperus, Manager", "Doug Chupella"),
    );
  });

  it("keeps only the signature line that names the signer", () => {
    const fields: SignFlowField[] = [
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 40,
        width: 28,
        height: 5,
        page: 100,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "date",
        label: "Date",
        x: 42,
        y: 41,
        width: 12,
        height: 3,
        page: 100,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 48,
        width: 28,
        height: 5,
        page: 100,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 56,
        width: 28,
        height: 5,
        page: 100,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 20,
        width: 28,
        height: 5,
        page: 12,
        recipientId: sponsor,
        required: true,
      }),
    ];

    const result = assignAlternateSignatureFields(fields, {
      recipientId: sponsor,
      signerName: "Douglas J Chupella",
      nearbyText: [
        "Douglas J Chupella",
        "",
        "Sonja Kuperus, Manager",
        "Dennis McQuarie, Manager",
        "Accepted by Sponsor",
      ],
    });

    assert.equal(result.changed, true);
    assert.equal(result.fields[0]?.recipientId, sponsor);
    assert.equal(result.fields[1]?.recipientId, sponsor);
    assert.equal(result.fields[2]?.recipientId, SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID);
    assert.equal(result.fields[2]?.required, false);
    assert.equal(result.fields[3]?.recipientId, SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID);
    assert.equal(result.fields[4]?.recipientId, sponsor);
  });

  it("can hand the block to a different manager on a later open", () => {
    const fields: SignFlowField[] = [
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 40,
        width: 28,
        height: 5,
        page: 1,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 48,
        width: 28,
        height: 5,
        page: 1,
        recipientId: SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID,
        required: false,
      }),
    ];

    const result = assignAlternateSignatureFields(fields, {
      recipientId: sponsor,
      signerName: "Sonja Kuperus",
      nearbyText: ["Douglas J Chupella", "Sonja Kuperus, Manager"],
    });

    assert.equal(result.fields[0]?.recipientId, SIGNFLOW_PARKED_ALTERNATE_RECIPIENT_ID);
    assert.equal(result.fields[1]?.recipientId, sponsor);
    assert.equal(result.fields[1]?.required, true);
  });

  it("leaves every line in place when none of them name the signer", () => {
    const fields: SignFlowField[] = [
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 40,
        width: 28,
        height: 5,
        page: 1,
        recipientId: sponsor,
        required: true,
      }),
      field({
        type: "signature",
        label: "Sponsor Signature",
        x: 10,
        y: 48,
        width: 28,
        height: 5,
        page: 1,
        recipientId: sponsor,
        required: true,
      }),
    ];

    const result = assignAlternateSignatureFields(fields, {
      recipientId: sponsor,
      signerName: "Collective Storage Partners",
      nearbyText: ["Douglas J Chupella", "Sonja Kuperus, Manager"],
    });

    assert.equal(result.changed, false);
    assert.equal(result.fields[0]?.recipientId, sponsor);
    assert.equal(result.fields[1]?.recipientId, sponsor);
  });
});

describe("editable signing date", () => {
  it("fills a signature date with today and leaves it as text", () => {
    const result = applyEditableSigningDatePrefill([
      field({
        type: "date_signed",
        label: "Date",
        x: 40,
        y: 40,
        width: 12,
        height: 3,
        page: 1,
        recipientId: sponsor,
      }),
      field({
        type: "date",
        label: "Formation date",
        x: 10,
        y: 10,
        width: 12,
        height: 3,
        page: 1,
        recipientId: "rec_investor",
        value: "01-Jan-2020",
      }),
    ]);

    assert.equal(result.changed, true);
    assert.equal(result.fields[0]?.type, "text");
    assert.match(String(result.fields[0]?.value), /^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
    assert.equal(result.fields[1]?.type, "date");
    assert.equal(result.fields[1]?.value, "01-Jan-2020");
    assert.equal(isEditableSigningDateField(result.fields[1]!), false);
  });
});
