# CLAUDE.md — RepeatOS MVP

## What RepeatOS Is

RepeatOS is a **multi-tenant hospitality retention platform** built for the Nigerian market. It gives restaurants, cafes, and bars a simple way to track repeat customers and reward loyalty — replacing manual stamp cards with an automated QR-based system.

The platform is built **once** and **configured per business**. Each business gets their own branded subdomain (e.g., `blisscafe.repeatos.co`) that runs on the same shared backend. We never rebuild the system per client — we only configure it.

Business owners pay a **one-time setup fee** via Paystack to book their package and get their account activated automatically.

---

## MVP Goal

Ship a working version that proves two loops:

**Loop 1 — Retention:** Customer scans QR → visit is logged → loyalty progress is shown → reward unlocks after X visits → business owner sees it in the dashboard.

**Loop 2 — Onboarding:** Business owner visits pricing page → selects package → pays via Paystack → account is auto-activated → QR code and dashboard are ready immediately.

---

## Tech Stack

| Layer     | Choice                        | Notes                                       |
|-----------|-------------------------------|---------------------------------------------|
| Backend   | Node.js + Express             | REST API, handles all business logic        |
| Database  | PostgreSQL                    | Single shared DB, all tenants in one DB     |
| Frontend  | Next.js                       | Handles subdomain routing per tenant        |
| Hosting   | DigitalOcean (single droplet) | One server for MVP, scale later             |
| Payments  | Paystack                      | One-time setup fee, NGN, webhook activation |
| Email     | Nodemailer or Resend           | Receipt to business owner, alert to admin   |
| QR Codes  | Generated server-side         | Encodes business_id + secure token          |

---

## The Most Important Rule in This Codebase

> **Every database table has a `business_id` column. Every query is scoped to it.**

This is what makes multi-tenancy work. If a query is missing `business_id`, it is a bug. There are no exceptions.

---

## Database Schema (MVP)

```sql
-- Available packages (seeded at launch, not dynamic)
CREATE TABLE packages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,          -- e.g. "Starter", "Growth"
  price_ngn    INT NOT NULL,           -- amount in kobo (e.g. 5000000 = ₦50,000)
  description  TEXT NOT NULL,
  features     JSONB NOT NULL          -- list of feature strings shown on pricing page
);

-- Tenant registry. One row per business.
-- is_active = false until payment is confirmed via Paystack webhook.
CREATE TABLE businesses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  subdomain               TEXT UNIQUE NOT NULL,
  email                   TEXT NOT NULL,               -- business owner email
  reward_visit_threshold  INT NOT NULL DEFAULT 5,
  reward_description      TEXT NOT NULL DEFAULT 'Free reward on your next visit',
  qr_token                TEXT UNIQUE NOT NULL,
  package_id              UUID REFERENCES packages(id),
  is_active               BOOLEAN NOT NULL DEFAULT FALSE, -- activated on payment
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Payment records. One row per Paystack transaction initiated.
CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  package_id          UUID NOT NULL REFERENCES packages(id),
  paystack_reference  TEXT UNIQUE NOT NULL,  -- Paystack transaction reference
  amount_kobo         INT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- One row per customer per business.
CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  phone       TEXT NOT NULL,
  visit_count INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, phone)
);

-- One row per QR scan event.
CREATE TABLE scans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  scanned_at  TIMESTAMPTZ DEFAULT NOW()
);

-- One row per reward unlocked.
CREATE TABLE rewards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  unlocked_at TIMESTAMPTZ DEFAULT NOW(),
  redeemed_at TIMESTAMPTZ DEFAULT NULL
);
```

---

## Package Booking & Payment Flow (Paystack)

This is the onboarding flow a business owner goes through to get their account activated.

### Step 1 — Pricing Page
- Business owner visits `repeatos.co/pricing`
- Page fetches and displays all rows from the `packages` table
- Each package card shows: name, price (₦), and features list
- "Get Started" button on each card leads to a signup + checkout form

### Step 2 — Signup Form
- Business owner fills in: business name, subdomain (slug), email, password, desired package
- Frontend submits to `POST /api/onboarding/register`
- Backend:
  1. Validates subdomain is available (unique check on `businesses.subdomain`)
  2. Creates a business row with `is_active = false`
  3. Generates a `qr_token` (`crypto.randomBytes(32).toString('hex')`)
  4. Creates an admin login record for the business owner
  5. Returns: `{ business_id, package_id, amount_kobo, email }`

### Step 3 — Paystack Checkout
- Frontend uses the Paystack Inline JS SDK to open the payment modal
- Initialize with:
  ```js
  PaystackPop.setup({
    key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
    email: businessOwnerEmail,
    amount: package.price_ngn,          // already in kobo
    currency: 'NGN',
    ref: paystackReference,             // generated server-side: unique per transaction
    metadata: {
      business_id: business.id,
      package_id: package.id
    },
    callback: function(response) {
      // Payment modal closed with success — verify via backend
      verifyPayment(response.reference)
    },
    onClose: function() {
      // User closed modal without paying — show "Payment cancelled" message
    }
  })
  ```
- Before opening the modal, create a `payments` row with `status = 'pending'`

### Step 4 — Paystack Webhook (Primary Activation Path)
- Paystack sends a POST to `POST /api/webhooks/paystack` when payment succeeds
- This webhook is the **source of truth** — not the frontend callback
- Backend must:
  1. Verify the webhook signature using `PAYSTACK_SECRET_KEY`:
     ```js
     const hash = crypto
       .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
       .update(JSON.stringify(req.body))
       .digest('hex')
     if (hash !== req.headers['x-paystack-signature']) return res.status(401).end()
     ```
  2. Check event type is `charge.success`
  3. Extract `reference` and `metadata.business_id` from the payload
  4. Update `payments` row: `status = 'success', paid_at = NOW()`
  5. Update `businesses` row: `is_active = true`
  6. Send receipt email to business owner (see Email section below)
  7. Send admin notification email
  8. Return `200 OK` immediately — Paystack will retry if it doesn't get a 200

### Step 5 — Frontend Verification (Fallback)
- After payment modal callback fires, frontend calls `POST /api/payments/verify`
- Backend calls Paystack's verify endpoint: `GET https://api.paystack.co/transaction/verify/{reference}`
- If status is `success` and `businesses.is_active` is still false → activate and send emails
- This catches cases where the webhook was delayed
- If already activated by webhook → just return the active business to the frontend

### Step 6 — Post-Payment
- Frontend redirects to: `https://{subdomain}.repeatos.co/admin`
- Business is live immediately — QR code is ready, dashboard is accessible
- No manual steps required from the RepeatOS team

---

## Email Notifications

### Receipt Email (to business owner)
Sent after `charge.success` webhook is processed.

**To:** `businesses.email`  
**Subject:** `Your RepeatOS account is live — {business name}`  
**Body should include:**
- Confirmation that payment was received
- Package name and amount paid
- Their dashboard URL: `https://{subdomain}.repeatos.co/admin`
- Login credentials (or a link to set password if using magic link)
- Their QR code image attached (or a download link)

### Admin Notification Email (to RepeatOS team)
Sent at the same time as the receipt email.

**To:** `ADMIN_EMAIL` env variable  
**Subject:** `New business activated — {business name}`  
**Body should include:**
- Business name, subdomain, email
- Package purchased and amount
- Timestamp of payment
- Link to view in internal admin (if built)

---

## API Routes (Full MVP)

```
-- Onboarding & Payments
POST   /api/onboarding/register        → Create business (is_active=false) + initiate payment record
POST   /api/payments/verify            → Frontend-triggered payment verification (fallback)
POST   /api/webhooks/paystack          → Paystack webhook receiver (primary activation)

-- Pricing
GET    /api/packages                   → Return all packages (for pricing page)

-- QR Scan (Customer-facing)
POST   /api/scan                       → Main scan endpoint (public, rate limited)

-- Admin Dashboard (Authenticated)
GET    /api/dashboard/metrics          → Metrics for admin dashboard
GET    /api/dashboard/rewards          → Rewards list
POST   /api/dashboard/redeem/:id       → Mark reward as redeemed

-- Auth
POST   /api/auth/login                 → Admin login
POST   /api/auth/logout                → Admin logout
```

---

## Environment Variables Required

```
# Paystack
PAYSTACK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_live_...

# Database
DATABASE_URL=postgresql://...

# Auth
JWT_SECRET=...

# Email
EMAIL_FROM=hello@repeatos.co
ADMIN_EMAIL=team@repeatos.co
RESEND_API_KEY=...   (or SMTP config if using Nodemailer)

# App
NEXT_PUBLIC_BASE_DOMAIN=repeatos.co
```

---

## Security (MVP Minimums)

- **Tenant isolation:** every query scoped to `business_id`
- **Webhook signature verification:** always validate `x-paystack-signature` header
- **Only activate on verified payment:** never activate a business based on frontend callback alone
- **Rate limiting on `/api/scan`:** max 1 scan per customer per 60 seconds
- **Admin auth:** JWT required on all `/api/dashboard/*` routes
- **HTTPS only:** all routes, enforce via DigitalOcean + Let's Encrypt
- **No raw DB errors exposed:** return clean error messages to client

---

## Inactive Business Handling

If a customer scans a QR code for a business where `is_active = false`:
- Return a friendly message: "This business is not yet active. Please check back soon."
- Do not log the scan
- Do not show any loyalty progress

This prevents scans being logged for businesses that haven't paid yet.

---

## Folder Structure

```
/repeatos
  /backend
    /routes
      scan.js             ← POST /api/scan
      dashboard.js        ← GET /api/dashboard/*
      auth.js             ← POST /api/auth/*
      onboarding.js       ← POST /api/onboarding/register
      payments.js         ← POST /api/payments/verify
      webhooks.js         ← POST /api/webhooks/paystack
      packages.js         ← GET /api/packages
    /middleware
      tenantResolver.js   ← Resolves subdomain → business_id
      rateLimiter.js      ← Scan rate limiting
      authGuard.js        ← Protects dashboard routes
    /services
      paystack.js         ← Paystack verify + webhook signature logic
      email.js            ← Receipt and admin notification emails
      activation.js       ← Business activation logic (shared by webhook + verify)
    /db
      schema.sql
      queries.js
    index.js

  /frontend
    /pages
      index.js            ← Marketing / landing page
      pricing.js          ← Package listing + signup form
      /admin
        index.js          ← Dashboard overview
        login.js          ← Admin login
    /components
      PackageCard.js      ← Pricing page package display
      StampProgress.js    ← Customer loyalty progress visual
      RewardBanner.js     ← Reward unlock message
      MetricsGrid.js      ← Dashboard metrics
      RewardsList.js      ← Rewards table with redeem button
    /lib
      api.js
      tenant.js
      paystack.js         ← Inline JS SDK wrapper
```

---

## What Claude Should Never Do

- Activate a business based on frontend callback alone — always verify via webhook or Paystack API
- Skip webhook signature verification — this is how fraud happens
- Write a DB query without `WHERE business_id = ?`
- Hardcode package prices or loyalty thresholds in application code
- Allow scans on a business where `is_active = false`
- Expose raw Paystack errors or DB errors to the client
- Build Tier 2 / Tier 3 loyalty features — that is not MVP scope
