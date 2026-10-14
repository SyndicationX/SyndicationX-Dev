import { isNotNull } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "../../database/db.js";
import { companies } from "../../schema/schema.js";
import { getStripeClient } from "./companyBilling.service.js";

export type PlatformCouponCode = {
  id: string;
  code: string;
  active: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
};

export type PlatformCouponRow = {
  id: string;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  duration: string;
  durationInMonths: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  redeemBy: string | null;
  valid: boolean;
  createdAt: string | null;
  promotionCodes: PlatformCouponCode[];
};

function isoFromUnix(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function couponFromPromo(promo: Stripe.PromotionCode): Stripe.Coupon | null {
  const coupon = promo.promotion?.coupon;
  if (!coupon || typeof coupon === "string") return null;
  return coupon;
}

function mapCode(promo: Stripe.PromotionCode): PlatformCouponCode {
  return {
    id: promo.id,
    code: promo.code,
    active: promo.active,
    timesRedeemed: promo.times_redeemed ?? 0,
    maxRedemptions: promo.max_redemptions ?? null,
    expiresAt: isoFromUnix(promo.expires_at),
  };
}

function mapCoupon(
  coupon: Stripe.Coupon,
  codes: PlatformCouponCode[],
): PlatformCouponRow {
  return {
    id: coupon.id,
    name: coupon.name ?? null,
    percentOff: coupon.percent_off ?? null,
    amountOffCents: coupon.amount_off ?? null,
    currency: coupon.currency ?? null,
    duration: coupon.duration,
    durationInMonths: coupon.duration_in_months ?? null,
    maxRedemptions: coupon.max_redemptions ?? null,
    timesRedeemed: coupon.times_redeemed ?? 0,
    redeemBy: isoFromUnix(coupon.redeem_by),
    valid:
      coupon.valid &&
      coupon.metadata?.status !== "inactive" &&
      (codes.length === 0 || codes.some((code) => code.active)),
    createdAt: isoFromUnix(coupon.created),
    promotionCodes: codes,
  };
}

export async function listPlatformCoupons(): Promise<PlatformCouponRow[]> {
  const stripe = getStripeClient();
  const [couponList, codeList] = await Promise.all([
    stripe.coupons.list({ limit: 100 }),
    stripe.promotionCodes.list({
      limit: 100,
      expand: ["data.promotion.coupon"],
    }),
  ]);

  const codesByCoupon = new Map<string, PlatformCouponCode[]>();
  const coupons = new Map<string, Stripe.Coupon>();
  for (const coupon of couponList.data) coupons.set(coupon.id, coupon);

  for (const promo of codeList.data) {
    const coupon = couponFromPromo(promo);
    const couponId =
      coupon?.id ??
      (typeof promo.promotion?.coupon === "string"
        ? promo.promotion.coupon
        : "");
    if (!couponId) continue;
    if (coupon && !coupons.has(coupon.id)) coupons.set(coupon.id, coupon);
    const bucket = codesByCoupon.get(couponId) ?? [];
    bucket.push(mapCode(promo));
    codesByCoupon.set(couponId, bucket);
  }

  return [...coupons.values()]
    .map((coupon) => mapCoupon(coupon, codesByCoupon.get(coupon.id) ?? []))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export type CreatePlatformCouponInput = {
  name: string;
  code: string;
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  duration: "once" | "repeating" | "forever";
  durationInMonths?: number;
  maxRedemptions?: number;
  redeemBy?: number;
};

export async function createPlatformCoupon(
  input: CreatePlatformCouponInput,
): Promise<PlatformCouponRow> {
  const stripe = getStripeClient();
  const coupon = await stripe.coupons.create({
    name: input.name,
    ...(input.percentOff != null
      ? { percent_off: input.percentOff }
      : {
          amount_off: input.amountOffCents,
          currency: (input.currency ?? "usd").toLowerCase(),
        }),
    duration: input.duration,
    ...(input.duration === "repeating"
      ? { duration_in_months: input.durationInMonths }
      : {}),
    ...(input.maxRedemptions != null
      ? { max_redemptions: input.maxRedemptions }
      : {}),
    ...(input.redeemBy != null ? { redeem_by: input.redeemBy } : {}),
  });

  try {
    const promo = await stripe.promotionCodes.create({
      code: input.code,
      promotion: { type: "coupon", coupon: coupon.id },
      ...(input.maxRedemptions != null
        ? { max_redemptions: input.maxRedemptions }
        : {}),
      ...(input.redeemBy != null ? { expires_at: input.redeemBy } : {}),
    });
    return mapCoupon(coupon, [mapCode(promo)]);
  } catch (err) {
    await stripe.coupons.del(coupon.id).catch(() => undefined);
    throw err;
  }
}

/** Turns off customer-facing codes and keeps the coupon in history. */
export async function deactivatePlatformCoupon(couponId: string): Promise<void> {
  const stripe = getStripeClient();
  const codes = await stripe.promotionCodes.list({
    limit: 100,
    coupon: couponId,
    active: true,
  });
  await Promise.all(
    codes.data.map((code) =>
      stripe.promotionCodes.update(code.id, { active: false }),
    ),
  );
  await stripe.coupons.update(couponId, {
    metadata: { status: "inactive" },
  });
}

export type OrgCouponUse = {
  couponId: string;
  code: string;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  redemptions: number;
  savedCents: number;
  lastUsedAt: string | null;
};

export type OrgCouponUsage = {
  id: string;
  name: string;
  redemptions: number;
  savedCents: number;
  coupons: OrgCouponUse[];
};

const USAGE_PAGE_LIMIT = 4;

function stripeCustomerId(customer: Stripe.Invoice["customer"]): string {
  if (!customer) return "";
  if (typeof customer === "string") return customer;
  return customer.id;
}

function discountRecord(
  discount: string | Stripe.Discount | Stripe.DeletedDiscount,
): Stripe.Discount | null {
  if (!discount || typeof discount === "string") return null;
  if ("deleted" in discount && discount.deleted) return null;
  return discount;
}

async function listDiscountedInvoices(
  stripe: Stripe,
): Promise<{ invoices: Stripe.Invoice[]; truncated: boolean }> {
  const invoices: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < USAGE_PAGE_LIMIT; page += 1) {
    const list = await stripe.invoices.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      expand: [
        "data.discounts",
        "data.discounts.promotion_code",
        "data.discounts.source.coupon",
      ],
    });
    invoices.push(...list.data);
    const last = list.data[list.data.length - 1];
    if (!list.has_more || !last) return { invoices, truncated: false };
    startingAfter = last.id;
  }
  return { invoices, truncated: true };
}

export type PromotionCodePreview = {
  code: string;
  promotionCodeId: string;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  duration: string;
  durationInMonths: number | null;
};

/** Active customer-facing code, for pricing preview and checkout. */
export async function lookupActivePromotionCode(
  rawCode: string,
): Promise<
  { ok: true; preview: PromotionCodePreview } | { ok: false; message: string }
> {
  const code = String(rawCode ?? "").trim();
  if (!/^[A-Za-z0-9-]{3,40}$/.test(code)) {
    return { ok: false, message: "Enter a valid coupon code." };
  }
  const stripe = getStripeClient();
  const list = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 1,
    expand: ["data.promotion.coupon"],
  });
  const promo = list.data[0];
  const coupon = promo ? couponFromPromo(promo) : null;
  if (!promo || !coupon || !coupon.valid || coupon.metadata?.status === "inactive") {
    return { ok: false, message: "That coupon code is not valid." };
  }
  return {
    ok: true,
    preview: {
      code: promo.code,
      promotionCodeId: promo.id,
      name: coupon.name ?? null,
      percentOff: coupon.percent_off ?? null,
      amountOffCents: coupon.amount_off ?? null,
      currency: coupon.currency ?? null,
      duration: coupon.duration,
      durationInMonths: coupon.duration_in_months ?? null,
    },
  };
}

/** Organizations and the promotion codes applied on their Stripe invoices. */
export async function listPlatformCouponUsage(): Promise<{
  organizations: OrgCouponUsage[];
  truncated: boolean;
}> {
  const stripe = getStripeClient();
  const [companyRows, invoicePage] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.name,
        stripeCustomerId: companies.stripeCustomerId,
      })
      .from(companies)
      .where(isNotNull(companies.stripeCustomerId)),
    listDiscountedInvoices(stripe),
  ]);

  const byCustomer = new Map<string, { id: string; name: string }>();
  const byCompanyId = new Map<string, { id: string; name: string }>();
  for (const row of companyRows) {
    const org = {
      id: String(row.id),
      name: String(row.name ?? "").trim() || "Organization",
    };
    byCompanyId.set(org.id.toLowerCase(), org);
    const customerId = String(row.stripeCustomerId ?? "").trim();
    if (customerId) byCustomer.set(customerId, org);
  }

  const grouped = new Map<
    string,
    { id: string; name: string; coupons: Map<string, OrgCouponUse> }
  >();

  for (const invoice of invoicePage.invoices) {
    const discounts = (invoice.discounts ?? [])
      .map(discountRecord)
      .filter((discount): discount is Stripe.Discount => discount != null);
    if (discounts.length === 0) continue;

    const metaCompany = String(
      invoice.metadata?.companyId ?? invoice.metadata?.company_id ?? "",
    )
      .trim()
      .toLowerCase();
    const customerId = stripeCustomerId(invoice.customer);
    const org =
      (metaCompany ? byCompanyId.get(metaCompany) : undefined) ??
      (customerId ? byCustomer.get(customerId) : undefined) ?? {
        id: customerId ? `stripe:${customerId}` : `invoice:${invoice.id}`,
        name: invoice.customer_name?.trim() || "Unknown organization",
      };
    const bucket = grouped.get(org.id) ?? {
      id: org.id,
      name: org.name,
      coupons: new Map<string, OrgCouponUse>(),
    };

    for (const discount of discounts) {
      const coupon = discount.source?.coupon;
      const couponObj = coupon && typeof coupon !== "string" ? coupon : null;
      const couponId = couponObj?.id ?? (typeof coupon === "string" ? coupon : "");
      const promo = discount.promotion_code;
      const code =
        promo && typeof promo !== "string" ? promo.code : couponId || "Coupon";
      const key = `${code}:${couponId}`;
      const saved = (invoice.total_discount_amounts ?? [])
        .filter((entry) => {
          const id =
            typeof entry.discount === "string" ? entry.discount : entry.discount.id;
          return id === discount.id;
        })
        .reduce((sum, entry) => sum + (entry.amount || 0), 0);
      const usedAt = isoFromUnix(
        invoice.status_transitions?.paid_at ?? invoice.created,
      );
      const current = bucket.coupons.get(key) ?? {
        couponId,
        code,
        name: couponObj?.name ?? null,
        percentOff: couponObj?.percent_off ?? null,
        amountOffCents: couponObj?.amount_off ?? null,
        currency: couponObj?.currency ?? invoice.currency ?? null,
        redemptions: 0,
        savedCents: 0,
        lastUsedAt: null,
      };
      current.redemptions += 1;
      current.savedCents += saved;
      if (usedAt && (!current.lastUsedAt || usedAt > current.lastUsedAt)) {
        current.lastUsedAt = usedAt;
      }
      bucket.coupons.set(key, current);
    }
    grouped.set(org.id, bucket);
  }

  const organizations = [...grouped.values()]
    .map((org) => {
      const coupons = [...org.coupons.values()].sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      return {
        id: org.id,
        name: org.name,
        redemptions: coupons.reduce((sum, coupon) => sum + coupon.redemptions, 0),
        savedCents: coupons.reduce((sum, coupon) => sum + coupon.savedCents, 0),
        coupons,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { organizations, truncated: invoicePage.truncated };
}
