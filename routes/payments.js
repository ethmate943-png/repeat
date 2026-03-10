import express from "express";
import crypto from "crypto";
import { verifyTransaction } from "../services/paystack.js";
import { query } from "../db/index.js";
import { sendBookingConfirmationEmail } from "../services/email.js";

const router = express.Router();

const SUBSCRIPTION_MONTHLY_KOBO = {
  Starter: 3500000,        // ₦35,000
  Growth: 5000000,         // ₦50,000
  Authority: 7500000,      // ₦75,000
  "Loyalty Add-On": 4000000, // ₦40,000
};

async function ensureSubscription(booking, monthlyAmountKobo, customerCode, authorizationCode) {
  if (!monthlyAmountKobo || !customerCode || !authorizationCode) {
    console.log("[subscriptions] Skipping subscription create — missing data", {
      monthlyAmountKobo,
      hasCustomerCode: !!customerCode,
      hasAuthorizationCode: !!authorizationCode,
    });
    return;
  }

  console.log("[subscriptions] Upserting subscription for booking_id=", booking.id, "plan=", booking.notes || "(none)");
  await query(
    `INSERT INTO subscriptions (
       business_id,
       booking_id,
       customer_email,
       plan_name,
       monthly_amount_kobo,
       paystack_customer_code,
       paystack_authorization_code,
       status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
     ON CONFLICT (booking_id) DO UPDATE SET
       monthly_amount_kobo = EXCLUDED.monthly_amount_kobo,
       paystack_customer_code = EXCLUDED.paystack_customer_code,
       paystack_authorization_code = EXCLUDED.paystack_authorization_code,
       status = 'active',
       updated_at = NOW()`,
    [
      booking.business_id,
      booking.id,
      booking.customer_email,
      (booking.notes || "").replace(/^Plan:\s*/i, "").trim() || "Subscription",
      monthlyAmountKobo,
      customerCode,
      authorizationCode,
    ],
  );
}

// POST /api/payments/verify
// Body: { reference }
// Verifies with Paystack; if success, marks booking paid and sends confirmation email (so it works when webhook can't reach localhost).
router.post("/verify", async (req, res) => {
  console.log("[payments] ─── POST /verify ───");
  try {
    const { reference } = req.body || {};
    if (!reference) {
      console.log("[payments] Verify: missing reference in body, returning 400.");
      return res.status(400).json({ error: "reference is required" });
    }
    console.log("[payments] Verify: reference =", reference);
    const result = await verifyTransaction(reference);
    const status = result?.data?.status;
    console.log("[payments] Verify: Paystack API returned status =", status ?? "(empty)");

    let emailSent = null;
    let emailError = null;

    // If Paystack says success, mark our DB as paid and send confirmation email (same as webhook).
    if (status === "success") {
      const rows = await query(
        `SELECT
           b.*,
           biz.name AS business_name,
           bp.id   AS bp_id,
           bp.amount_kobo,
           bp.status AS payment_status,
           bp.paystack_reference
         FROM booking_payments bp
         JOIN bookings b ON b.id = bp.booking_id
         LEFT JOIN businesses biz ON biz.id = b.business_id
         WHERE bp.paystack_reference = $1`,
        [reference],
      );
      if (rows.rowCount > 0) {
        const booking = rows.rows[0];
        if (booking.payment_status !== "success") {
          console.log("[payments] Verify: marking payment and booking as paid, booking_id=" + booking.id);
          await query(
            `UPDATE booking_payments SET status = 'success', paid_at = NOW() WHERE id = $1`,
            [booking.bp_id],
          );
          await query(
            `UPDATE bookings SET status = 'paid', updated_at = NOW() WHERE id = $1`,
            [booking.id],
          );
          console.log("[payments] Verify: triggering confirmation email to " + booking.customer_email);
          const emailResult = await sendBookingConfirmationEmail(booking, {
            paystack_reference: booking.paystack_reference,
            amount_kobo: booking.amount_kobo,
          });
          emailSent = emailResult.sent;
          emailError = emailResult.error ?? null;
          if (emailResult.sent) {
            console.log("[payments] Verify: confirmation email sent successfully.");
          } else {
            console.warn("[payments] Verify: confirmation email was NOT sent. Reason:", emailResult.error || "unknown");
          }

          // Ensure subscription record for monthly infrastructure
          const planName = (booking.notes || "").replace(/^Plan:\s*/i, "").trim() || "Subscription";
          const monthlyAmountKobo = SUBSCRIPTION_MONTHLY_KOBO[planName] || null;
          const auth = result?.data?.data?.authorization;
          const customer = result?.data?.data?.customer;
          const authorizationCode = auth?.authorization_code || null;
          const customerCode = customer?.customer_code || null;
          await ensureSubscription(booking, monthlyAmountKobo, customerCode, authorizationCode);
        }
      } else {
        console.log("[payments] Verify: no booking found for reference (cannot send email).");
      }
    } else {
      console.log("[payments] Verify: Paystack status is not success, skipping email. status=" + status);
    }

    return res.json({
      ...result,
      ...(emailSent !== null && { emailSent, emailError }),
    });
  } catch (err) {
    console.error("[payments] Verify failed:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
});

// POST /api/payments/webhooks/paystack
// Configure this URL in your Paystack dashboard.
router.post("/webhooks/paystack", express.raw({ type: "application/json" }), async (req, res) => {
  console.log("[webhook] ─── POST /webhooks/paystack (received) ───");
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      console.warn("[webhook] PAYSTACK_SECRET_KEY not set; cannot verify signature.");
      return res.status(500).end();
    }

    const signature = req.headers["x-paystack-signature"];
    const computed = crypto
      .createHmac("sha512", secret)
      .update(req.body)
      .digest("hex");

    if (computed !== signature) {
      console.warn("[webhook] Signature mismatch — rejecting request.");
      return res.status(401).end();
    }

    const event = JSON.parse(req.body.toString("utf8"));
    const eventType = event?.event || "?";
    console.log("[webhook] Event type:", eventType);

    if (event.event === "charge.success") {
      const ref = event.data?.reference;
      if (!ref) {
        console.warn("[webhook] charge.success but event.data.reference is missing; ack without sending email.");
        return res.status(200).end();
      }
      console.log("[webhook] charge.success — reference =", ref);

      // Look up booking + payment by reference (include business name for email)
      const result = await query(
        `SELECT
           b.*,
           biz.name AS business_name,
           bp.id   AS bp_id,
           bp.amount_kobo,
           bp.status AS payment_status,
           bp.paystack_reference
         FROM booking_payments bp
         JOIN bookings b ON b.id = bp.booking_id
         LEFT JOIN businesses biz ON biz.id = b.business_id
         WHERE bp.paystack_reference = $1`,
        [ref],
      );

      if (result.rowCount === 0) {
        console.warn("[webhook] No booking found in DB for reference", ref, "— ack without sending email.");
        return res.status(200).end();
      }

      const booking = result.rows[0];

      if (booking.payment_status === "success") {
        console.log("[webhook] Booking id", booking.id, "already marked paid (idempotent); ack without re-sending email.");
        return res.status(200).end();
      }

      console.log("[webhook] Marking payment and booking as paid — booking_id =", booking.id);
      await query(
        `UPDATE booking_payments
         SET status = 'success', paid_at = NOW()
         WHERE id = $1`,
        [booking.bp_id],
      );

      await query(
        `UPDATE bookings
         SET status = 'paid', updated_at = NOW()
         WHERE id = $1`,
        [booking.id],
      );

      console.log("[webhook] Triggering confirmation email to " + booking.customer_email);
      const emailResult = await sendBookingConfirmationEmail(booking, {
        paystack_reference: booking.paystack_reference,
        amount_kobo: booking.amount_kobo,
      });
      if (emailResult.sent) {
        console.log("[webhook] Confirmation email sent successfully.");
      } else {
        console.warn("[webhook] Confirmation email was NOT sent. Reason:", emailResult.error || "unknown");
      }

      // Ensure subscription record for monthly infrastructure
      const planName = (booking.notes || "").replace(/^Plan:\s*/i, "").trim() || "Subscription";
      const monthlyAmountKobo = SUBSCRIPTION_MONTHLY_KOBO[planName] || null;
      const auth = event?.data?.authorization;
      const customer = event?.data?.customer;
      const authorizationCode = auth?.authorization_code || null;
      const customerCode = customer?.customer_code || null;
      await ensureSubscription(booking, monthlyAmountKobo, customerCode, authorizationCode);
    }

    return res.status(200).end();
  } catch (err) {
    console.error("[webhook] Error processing webhook:", err?.message || err);
    // Still respond 200 so Paystack doesn't keep retrying on our bug
    return res.status(200).end();
  }
});

// POST /api/payments/send-confirmation
// Manually trigger confirmation email for a paid booking (for local testing when webhook can't reach localhost).
// Body: { reference } — Paystack reference from the payment.
router.post("/send-confirmation", async (req, res) => {
  console.log("[payments] ─── POST /send-confirmation ───");
  try {
    const { reference } = req.body || {};
    if (!reference) {
      console.log("[payments] send-confirmation: missing reference, returning 400.");
      return res.status(400).json({ error: "reference is required" });
    }
    console.log("[payments] send-confirmation: reference =", reference);

    const result = await query(
      `SELECT
         b.*,
         biz.name AS business_name,
         bp.id AS bp_id,
         bp.amount_kobo,
         bp.status AS payment_status,
         bp.paystack_reference
       FROM booking_payments bp
       JOIN bookings b ON b.id = bp.booking_id
       LEFT JOIN businesses biz ON biz.id = b.business_id
       WHERE bp.paystack_reference = $1`,
      [reference],
    );

    if (result.rowCount === 0) {
      console.warn("[payments] send-confirmation: no booking found for reference.");
      return res.status(404).json({ error: "Booking not found for this reference" });
    }

    const booking = result.rows[0];
    if (booking.payment_status !== "success") {
      console.log("[payments] send-confirmation: booking not yet marked paid (webhook may not have run). Sending email anyway for testing.");
    }

    console.log("[payments] send-confirmation: triggering email to", booking.customer_email);
    const emailResult = await sendBookingConfirmationEmail(booking, {
      paystack_reference: booking.paystack_reference,
      amount_kobo: booking.amount_kobo,
    });
    if (emailResult.sent) {
      console.log("[payments] send-confirmation: email sent successfully.");
    } else {
      console.warn("[payments] send-confirmation: email was NOT sent. Reason:", emailResult.error || "unknown");
    }

    return res.json({
      ok: true,
      emailSent: emailResult.sent,
      emailError: emailResult.error ?? null,
      message: emailResult.sent
        ? "Confirmation email sent."
        : "Email was not sent. " + (emailResult.error || "Unknown error."),
    });
  } catch (err) {
    console.error("[payments] send-confirmation failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to send confirmation" });
  }
});

export default router;

