import express from "express";
import crypto from "crypto";
import { query } from "../db/index.js";
import { chargeAuthorization } from "../services/paystack.js";

const router = express.Router();

// POST /api/subscriptions/charge/:id
// Manually trigger a monthly charge for a single subscription.
// Intended to be called by a scheduled job or admin tool, not from the public site.
router.post("/charge/:id", async (req, res) => {
  const { id } = req.params;
  console.log("[subscriptions] POST /charge/" + id);
  try {
    const subRes = await query(
      `SELECT s.*, b.customer_email, b.business_id
       FROM subscriptions s
       JOIN bookings b ON b.id = s.booking_id
       WHERE s.id = $1`,
      [id],
    );

    if (subRes.rowCount === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const sub = subRes.rows[0];
    if (sub.status !== "active") {
      return res.status(400).json({ error: "Subscription is not active" });
    }

    if (!sub.paystack_authorization_code || !sub.customer_email) {
      return res.status(400).json({ error: "Subscription is missing Paystack authorization details" });
    }

    const reference = `sub_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    console.log(
      "[subscriptions] Charging monthly for subscription",
      id,
      "amount_kobo=",
      sub.monthly_amount_kobo,
      "reference=",
      reference,
    );

    const charge = await chargeAuthorization({
      email: sub.customer_email,
      authorizationCode: sub.paystack_authorization_code,
      amountKobo: sub.monthly_amount_kobo,
      reference,
      metadata: {
        subscription_id: sub.id,
        booking_id: sub.booking_id,
        business_id: sub.business_id,
        plan_name: sub.plan_name,
        kind: "monthly_infrastructure",
      },
    });

    // Update tracking info (best-effort; webhook will still be source of truth about success/failure)
    await query(
      `UPDATE subscriptions
       SET last_charged_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id],
    );

    return res.json({ ok: true, charge });
  } catch (err) {
    console.error("[subscriptions] charge failed:", err?.response?.data || err?.message || err);
    return res.status(500).json({ error: "Failed to charge subscription" });
  }
});

export default router;

