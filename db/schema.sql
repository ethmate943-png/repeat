-- Bookings and Payments schema for reservations
-- Assumes `businesses` table already exists (see CLAUDE.md).

-- Customer bookings for a given business.
CREATE TABLE IF NOT EXISTS bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id),

  customer_name       TEXT NOT NULL,
  customer_email      TEXT NOT NULL,
  customer_phone      TEXT,

  reservation_date    DATE NOT NULL,
  reservation_time    TIME WITH TIME ZONE NOT NULL,
  party_size          INT  NOT NULL,

  notes               TEXT,

  total_amount_kobo   INT  NOT NULL,      -- price in kobo
  paystack_reference  TEXT UNIQUE,        -- filled when payment is initiated

  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending  = created, not yet sent to Paystack
  -- awaiting_payment = redirected to Paystack, waiting for confirmation
  -- paid     = Paystack charge.success received / verified
  -- cancelled = user or admin cancelled

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual Paystack transactions tied to a booking.
CREATE TABLE IF NOT EXISTS booking_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  paystack_reference  TEXT UNIQUE NOT NULL,
  amount_kobo         INT  NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | success | failed

  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

