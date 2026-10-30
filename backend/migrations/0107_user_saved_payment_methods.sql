-- Saved cards and bank accounts belong to the user who added them.
-- They are not an organization-wide payment method list.

ALTER TABLE public.company_billing_payment_methods
  ADD COLUMN IF NOT EXISTS added_by_user_id uuid;

CREATE INDEX IF NOT EXISTS company_billing_payment_methods_added_by_idx
  ON public.company_billing_payment_methods (company_id, added_by_user_id);

COMMENT ON COLUMN public.company_billing_payment_methods.added_by_user_id IS
  'Portal user who saved this payment method. Only that user can see or reuse it.';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_uidx
  ON public.users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON COLUMN public.users.stripe_customer_id IS
  'Stripe customer that holds this user''s saved cards. Not the company customer.';
