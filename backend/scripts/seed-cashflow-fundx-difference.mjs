/**
 * Fresh "Cashflow Fundx" deal for chinmayee@example.com.
 * Starter subscription is the Stripe Starter price ($49). The catalog price is $149,
 * so the deal stays locked with a $100 difference until that gap is paid.
 *
 * From the backend folder:
 *   node scripts/seed-cashflow-fundx-difference.mjs
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";
import Stripe from "stripe";

const envPath = path.resolve(process.cwd(), ".env.local");
const envText = fs.readFileSync(envPath, "utf8");

function envValue(name) {
  const matches = [...envText.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  const raw = matches.at(-1)?.[1]?.trim() ?? "";
  return raw.replace(/^["']|["']$/g, "");
}

const stripeKey = envValue("STRIPE_SECRET_KEY");
const starterPriceId = envValue("STARTER_5_MONTH_PRICING");
if (!stripeKey || !starterPriceId) {
  throw new Error("STRIPE_SECRET_KEY and STARTER_5_MONTH_PRICING are required in .env.local");
}

const stripe = new Stripe(stripeKey);
const db = new pg.Client({
  user: envValue("DATABASE_USER") || "postgres",
  password: envValue("DATABASE_PASSWORD"),
  host: (envValue("DATABASE_HOST") || "localhost").trim(),
  port: Number(envValue("DATABASE_PORT") || 5432),
  database: envValue("DATABASE_NAME"),
});

const EMAIL = "chinmayee@example.com";
const OFFERING_SIZE = "2500000";

await db.connect();

const userResult = await db.query(
  `SELECT id, organization_id, first_name FROM users WHERE lower(email) = lower($1) LIMIT 1`,
  [EMAIL],
);
const user = userResult.rows[0];
if (!user) throw new Error(`No user found for ${EMAIL}`);

const companyResult = await db.query(
  `SELECT id FROM companies
   WHERE id = $1
      OR id IN (
        SELECT organization_id FROM add_deal_form
        WHERE deal_name ILIKE 'Cashflow Fundx%' AND organization_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      )
   LIMIT 1`,
  [user.organization_id],
);
const companyId = companyResult.rows[0]?.id;
if (!companyId) throw new Error(`${EMAIL} is not attached to a company.`);

const sourceResult = await db.query(
  `SELECT * FROM add_deal_form
   WHERE organization_id = $1
     AND (deal_name ILIKE 'Cashflow Fundx%' OR deal_name ILIKE 'Difference $100%')
   ORDER BY created_at DESC
   LIMIT 1`,
  [companyId],
);
const source = sourceResult.rows[0];
if (!source) throw new Error("No Cashflow Fundx or Difference $100 deal to copy.");

const names = await db.query(
  `SELECT deal_name FROM add_deal_form
   WHERE organization_id = $1 AND deal_name ILIKE 'Cashflow Fundx%'`,
  [companyId],
);
const taken = new Set(names.rows.map((row) => row.deal_name));
let dealName = "Cashflow Fundx";
for (let n = 2; taken.has(dealName); n += 1) {
  dealName = `Cashflow Fundx ${n}`;
}

const customerId = source.stripe_payer_customer_id;
if (!customerId) throw new Error("Source deal has no Stripe customer.");
const cards = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
const paymentMethodId = cards.data[0]?.id;
if (!paymentMethodId) throw new Error(`No saved card on ${customerId}.`);

const inserted = await db.query(
  `INSERT INTO add_deal_form (
     organization_id, deal_name, deal_type, deal_stage, sec_type,
     owning_entity_name, funds_required_before_gp_sign, auto_send_funding_instructions,
     property_name, country, city, offering_status, offering_visibility,
     show_on_investbase, internal_name, offering_preview_token,
     offering_investor_preview_json, archived,
     stripe_distribution_funding_status,
     stripe_distribution_funding_details_submitted,
     stripe_distribution_funding_payouts_enabled,
     stripe_plan_id, stripe_billing_cycle, stripe_subscription_status,
     stripe_seat_band, saas_billing_starts_at, extra_company_users_paid,
     stripe_payer_customer_id
   )
   VALUES (
     $1, $2, $3, 'raising_capital', $4,
     $5, $6, $7,
     $8, $9, $10, $11, $12,
     $13, $2, $14,
     $15, false,
     $16, $17, $18,
     'starter', 'monthly', 'none',
     '5', $19, 0,
     $20
   )
   RETURNING id`,
  [
    companyId,
    dealName,
    source.deal_type,
    source.sec_type,
    source.owning_entity_name,
    source.funds_required_before_gp_sign,
    source.auto_send_funding_instructions,
    source.property_name,
    source.country,
    source.city,
    source.offering_status,
    source.offering_visibility,
    source.show_on_investbase,
    crypto.randomBytes(24).toString("base64url"),
    source.offering_investor_preview_json,
    source.stripe_distribution_funding_status,
    source.stripe_distribution_funding_details_submitted,
    source.stripe_distribution_funding_payouts_enabled,
    source.saas_billing_starts_at,
    customerId,
  ],
);
const dealId = inserted.rows[0].id;

await db.query(
  `INSERT INTO deal_investor_class (
     deal_id, name, offering_size, status
   )
   SELECT $1, COALESCE(name, 'Class A'), $2, COALESCE(status, 'draft')
   FROM deal_investor_class
   WHERE deal_id = $3
   LIMIT 1`,
  [dealId, OFFERING_SIZE, source.id],
);
const classCount = await db.query(
  `SELECT count(*)::int AS n FROM deal_investor_class WHERE deal_id = $1`,
  [dealId],
);
if (classCount.rows[0].n === 0) {
  await db.query(
    `INSERT INTO deal_investor_class (deal_id, name, offering_size, status)
     VALUES ($1, 'Class A', $2, 'draft')`,
    [dealId, OFFERING_SIZE],
  );
}

await db.query(
  `INSERT INTO deal_member (
     deal_id, added_by, contact_member_id, deal_member_role, deal_member_name,
     send_invitation_mail, is_draft, lead_sponsor_email_intercept
   ) VALUES ($1, $2::uuid, $3, 'Lead Sponsor', $4, 'no', false, 'yes')`,
  [dealId, user.id, user.id, user.first_name || "Chinmayee"],
);

const subscription = await stripe.subscriptions.create({
  customer: customerId,
  items: [{ price: starterPriceId }],
  default_payment_method: paymentMethodId,
  metadata: {
    billingCycle: "monthly",
    billingScope: "deal",
    companyId,
    dealId,
    dealName,
    planId: "starter",
    seatBand: "5",
    payerUserId: user.id,
    purpose: "test_difference_100",
  },
});
const periodEnd = subscription.items?.data?.[0]?.current_period_end
  ? new Date(subscription.items.data[0].current_period_end * 1000)
  : null;

await db.query(
  `UPDATE add_deal_form
   SET stripe_subscription_id = $2,
       stripe_subscription_status = $3,
       stripe_price_id = $4,
       stripe_current_period_end = $5,
       saas_coupon_code = NULL
   WHERE id = $1`,
  [dealId, subscription.id, subscription.status, starterPriceId, periodEnd],
);

if (!user.organization_id) {
  await db.query(`UPDATE users SET organization_id = $2 WHERE id = $1`, [
    user.id,
    companyId,
  ]);
}

const paidCents = subscription.items.data[0]?.price?.unit_amount ?? 0;
console.log(
  JSON.stringify(
    {
      email: EMAIL,
      dealId,
      dealName,
      companyId,
      subscriptionId: subscription.id,
      status: subscription.status,
      paidDollars: paidCents / 100,
      catalogDollars: 149,
      differenceDollars: (14900 - paidCents) / 100,
    },
    null,
    2,
  ),
);

await db.end();
