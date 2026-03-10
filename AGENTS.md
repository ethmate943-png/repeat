# AGENTS.md — RepeatOS MVP

## Project Context

RepeatOS is a multi-tenant loyalty SaaS for Nigerian hospitality businesses. One shared backend powers many branded tenant instances, each on their own subdomain. All data is separated by `business_id`.

Business owners pay a **one-time setup fee via Paystack** to activate their account. Everything after payment is automatic — no manual steps from the RepeatOS team.

The MVP has two core loops:
1. **Payment loop:** Business registers → pays via Paystack → account auto-activates → QR and dashboard are live
2. **Retention loop:** Customer scans QR → visit logged → reward unlocks → owner sees it in dashboard

---

## Agent Roles

---

## Agent 1 — Payment & Onboarding Agent

**Owns:** Package listing, business registration, Paystack checkout, webhook processing, account activation, email notifications.

### What This Agent Does

This agent handles everything from the moment a business owner lands on the pricing page to the moment their account goes live. It is the entry point of the entire platform.

### Responsibilities

**Pricing Page Data (`GET /api/packages`)**
- Query all rows from the `packages` table
- Return: `{ id, name, price_ngn, description, features[] }`
- This is a public, unauthenticated endpoint
- The frontend renders one card per package on `repeatos.co/pricing`

**Business Registration (`POST /api/onboarding/register`)**

Accepts:
```json
{
  "business_name": "Bliss Cafe",
  "subdomain": "blisscafe",
  "email": "owner@blisscafe.com",
  "password": "...",
  "package_id": "uuid"
}
```

Steps:
1. Validate subdomain is URL-safe (lowercase, alphanumeric, hyphens only)
2. Check subdomain is not already taken: `SELECT id FROM businesses WHERE subdomain = ?`
3. If taken → return `409 Conflict` with message: "That subdomain is already in use"
4. Generate `qr_token`: `crypto.randomBytes(32).toString('hex')`
5. Insert into `businesses` with `is_active = false`
6. Hash password and create admin login record
7. Generate a unique Paystack reference: `repeatos_${Date.now()}_${uuid}`
8. Insert into `payments` with `status = 'pending'`
9. Return: `{ business_id, paystack_reference, amount_kobo, email }`

The frontend uses the returned data to initialise the Paystack Inline JS SDK and open the payment modal.

**Paystack Webhook (`POST /api/webhooks/paystack`)**

This is the **primary activation path**. Paystack calls this endpoint when a payment succeeds. It must respond with `200 OK` within 30 seconds or Paystack will retry.

Steps:
1. Read raw request body as string (do not parse JSON before verifying)
2. Verify signature:
   ```js
   const hash = crypto
     .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
     .update(rawBody)
     .digest('hex')
   if (hash !== req.headers['x-paystack-signature']) {
     return res.status(401).end()
   }
   ```
3. Parse the body and check: `event === 'charge.success'`
4. If not `charge.success` → return `200 OK` immediately (Paystack sends other event types too)
5. Extract `data.reference` and `data.metadata.business_id`
6. Look up the payment record: `SELECT * FROM payments WHERE paystack_reference = ?`
7. If already `status = 'success'` → return `200 OK` (idempotency — Paystack may retry)
8. Update payment: `SET status = 'success', paid_at = NOW()`
9. Call the shared `activateBusiness(business_id)` function (see below)
10. Return `200 OK`

**Payment Verification (`POST /api/payments/verify`)**

This is the **fallback path**, triggered by the frontend after the Paystack modal callback fires.

Steps:
1. Accept: `{ reference }`
2. Call Paystack verify API:
   ```
   GET https://api.paystack.co/transaction/verify/{reference}
   Authorization: Bearer {PAYSTACK_SECRET_KEY}
   ```
3. Check response: `data.status === 'success'`
4. If success and business not yet active → call `activateBusiness(business_id)`
5. If already active → return current business state (don't re-activate or re-send emails)
6. Return: `{ is_active: true, dashboard_url: 'https://{subdomain}.repeatos.co/admin' }`

**Shared `activateBusiness(business_id)` Function**

Used by both webhook and verify routes. Must be idempotent — safe to call multiple times.

```js
async function activateBusiness(businessId) {
  // 1. Fetch business — if already active, return early
  const business = await db.query(
    'SELECT * FROM businesses WHERE id = $1', [businessId]
  )
  if (business.is_active) return  // already done

  // 2. Activate
  await db.query(
    'UPDATE businesses SET is_active = true WHERE id = $1', [businessId]
  )

  // 3. Send receipt email to business owner
  await emailService.sendReceipt(business)

  // 4. Send admin notification
  await emailService.notifyAdmin(business)
}
```

**Email: Receipt (to Business Owner)**

Send via Resend or Nodemailer after activation.

- **To:** `businesses.email`
- **Subject:** `Your RepeatOS account is live — {business_name}`
- **Content:**
  - Payment confirmed message
  - Package name + amount paid (formatted as ₦XX,XXX)
  - Dashboard URL: `https://{subdomain}.repeatos.co/admin`
  - Login credentials or set-password link
  - QR code download link or attached image

**Email: Admin Notification (to RepeatOS team)**

- **To:** `process.env.ADMIN_EMAIL`
- **Subject:** `New signup — {business_name} ({package_name})`
- **Content:** business name, subdomain, email, package, amount, timestamp

### Rules This Agent Must Never Break
- Never activate a business without verifying payment with Paystack (not just trusting frontend)
- Always verify webhook signature before processing — an unverified webhook is a security hole
- `activateBusiness` must be idempotent — check `is_active` before doing anything
- Never send duplicate emails — check `is_active` before calling `activateBusiness`
- The webhook endpoint must return `200 OK` fast — do not put slow operations before the response
- Always store `paystack_reference` at registration time, before the payment modal opens

---

## Agent 2 — Scan Agent

**Owns:** `POST /api/scan` and everything it touches.

### Step-by-Step Responsibilities

**Step 1 — Validate the request**
- Accept: `{ token: string, phone: string }`
- Look up `businesses WHERE qr_token = token`
- If no match → return `400 Bad Request`: "Invalid QR code"
- If business `is_active = false` → return `403 Forbidden`: "This business is not yet active"
- If match → `business_id` is resolved

**Step 2 — Rate limit check**
- Check: `SELECT id FROM scans WHERE customer_id = ? AND scanned_at > NOW() - INTERVAL '60 seconds'`
- (On first scan, customer doesn't exist yet — skip this check for brand new customers)
- If recent scan exists → return `429`: "You already scanned recently. Please wait before scanning again."

**Step 3 — Resolve or create customer**
- Query: `SELECT * FROM customers WHERE business_id = ? AND phone = ?`
- New customer → `INSERT (business_id, phone, visit_count = 1)`
- Returning customer → `UPDATE SET visit_count = visit_count + 1 WHERE id = ?`

**Step 4 — Log the scan**
- Always: `INSERT INTO scans (business_id, customer_id)`

**Step 5 — Loyalty check**
- Fetch `reward_visit_threshold` from `businesses`
- Check for existing unredeemed reward: `SELECT id FROM rewards WHERE business_id = ? AND customer_id = ? AND redeemed_at IS NULL`
- If `visit_count >= threshold` AND no unredeemed reward → `INSERT INTO rewards`

**Step 6 — Return response**
```json
{
  "visit_count": 4,
  "threshold": 5,
  "reward_unlocked": false,
  "reward_description": "Free coffee on your 5th visit",
  "message": "Welcome back! 1 more visit to go."
}
```

### Rules This Agent Must Never Break
- Check `is_active` before processing any scan
- Never skip rate limiting
- Always log to `scans` table
- All queries scoped with `business_id`
- Never expose raw DB errors

---

## Agent 3 — Loyalty Agent

**Owns:** Reward rule evaluation, reward records, redemption.

### Responsibilities

**Reward Unlock Logic**
- Rule: `customer.visit_count >= business.reward_visit_threshold`
- Threshold comes from `businesses` table — never hardcoded
- Check for existing unredeemed reward before inserting a new one — no double-rewards

**Reward Redemption (`POST /api/dashboard/redeem/:id`)**
- `UPDATE rewards SET redeemed_at = NOW() WHERE id = ? AND business_id = ?`
- Always include `business_id` in WHERE — never allow cross-tenant redemption

**Not in MVP**
- Reward expiration, multiple reward types, tiered rewards, frequency triggers

### Rules This Agent Must Never Break
- Reward threshold is always read from DB, never hardcoded
- Check for existing unredeemed reward before creating a new one
- All reward queries scoped with `business_id`

---

## Agent 4 — Analytics Agent

**Owns:** All dashboard metrics.

### Metrics to Compute (all scoped to `business_id`)

| Metric | Query |
|--------|-------|
| Total scans | `COUNT(*) FROM scans WHERE business_id = $1` |
| Unique customers | `COUNT(DISTINCT customer_id) FROM scans WHERE business_id = $1` |
| Repeat customers | `COUNT(*) FROM customers WHERE business_id = $1 AND visit_count > 1` |
| Repeat rate | `repeat / unique` — return 0 if unique = 0 |
| Rewards unlocked | `COUNT(*) FROM rewards WHERE business_id = $1` |
| Rewards redeemed | `COUNT(*) FROM rewards WHERE business_id = $1 AND redeemed_at IS NOT NULL` |

**Rewards List**
```sql
SELECT r.id, r.unlocked_at, r.redeemed_at, c.phone
FROM rewards r
JOIN customers c ON c.id = r.customer_id
WHERE r.business_id = $1
ORDER BY r.unlocked_at DESC
LIMIT 50 OFFSET $2
```

### Rules This Agent Must Never Break
- Every query scoped to `business_id`
- Handle zero-state gracefully — return 0, not an error
- Never aggregate across tenants

---

## Agent 5 — Frontend Agent

**Owns:** Pricing page, signup form, customer loyalty page, admin dashboard.

### Pricing Page (`repeatos.co/pricing`)
- Fetch packages from `GET /api/packages`
- Render one card per package: name, price (₦), features list, "Get Started" button
- "Get Started" → opens signup form for that package

### Signup + Checkout Form
- Fields: business name, subdomain, email, password
- On submit → call `POST /api/onboarding/register`
- On success → initialise Paystack Inline JS with returned `reference` and `amount_kobo`
- On payment success callback → call `POST /api/payments/verify` then redirect to dashboard
- On payment modal close without paying → show "Payment cancelled" and allow retry

### Customer Loyalty Page (`{subdomain}.repeatos.co`)
- Resolve business from subdomain
- If business `is_active = false` → show "Coming soon" message
- Phone number input → call `POST /api/scan`
- Show: `StampProgress`, `RewardBanner` if reward unlocked

### Admin Dashboard (`{subdomain}.repeatos.co/admin`)
- Login screen → `POST /api/auth/login` → store JWT
- Protected: redirect to login if no valid JWT
- Show: `MetricsGrid` (all 6 metrics), `RewardsList` with redeem button

### Rules This Agent Must Never Break
- Never hardcode business name, branding, or reward text — always pull from API
- Handle Paystack modal close gracefully — don't leave the user stuck
- Admin routes always check for JWT before rendering
- Show appropriate state for inactive businesses

---

## Agent 6 — Auth Agent

**Owns:** Admin login, JWT middleware, route protection.

### Responsibilities

**Login (`POST /api/auth/login`)**
- Accept: `{ email, password }`
- Look up admin record scoped to the business (resolved from subdomain)
- Verify password hash
- On success → return signed JWT: `{ business_id, admin_id, exp: 7 days }`
- On failure → `401 Unauthorized`

**JWT Middleware (`authGuard.js`)**
- Applied to all `/api/dashboard/*` routes
- Reads `Authorization: Bearer {token}`
- Verifies signature and expiry
- Attaches `business_id` from token to request context
- Rejects with `401` if missing, invalid, or expired

### Rules This Agent Must Never Break
- JWT must contain `business_id` — all dashboard queries use this
- JWT secret must come from `process.env.JWT_SECRET`, never hardcoded
- Never let an unauthenticated request reach a dashboard route

---

## Universal Rules (All Agents)

| Rule | Why |
|------|-----|
| All DB queries include `WHERE business_id = ?` | Core tenant isolation |
| Loyalty thresholds come from DB, not code | Configurable per business |
| Never activate a business without verified Paystack payment | Prevents fraud |
| Webhook signature must be verified before processing | Security |
| `activateBusiness` must be idempotent | Paystack may send duplicate webhooks |
| Rate limit the scan endpoint | Prevents abuse |
| Check `is_active` before processing scans | Unpaid businesses must not receive scan data |
| Never expose raw DB or Paystack errors to the client | Security + UX |

---

## Handoff Format

```
HANDOFF:
From agent:     [agent name]
To agent:       [agent name]
business_id:    [uuid]
Current state:  [what just happened]
Next action:    [what needs to happen next]
Relevant data:  [reference, customer_id, visit_count, reward_id — whatever applies]
```
