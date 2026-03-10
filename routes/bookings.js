import express from "express";
import crypto from "crypto";
import { query } from "../db/index.js";
import { initializeTransaction } from "../services/paystack.js";

const router = express.Router();

function createReference(prefix = "booking") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

// POST /api/bookings
// Create booking only (no payment yet)
router.post("/", async (req, res) => {
  console.log("[bookings] POST / — create booking");
  try {
    const {
      business_id,
      business_name,
      subdomain,
      customer_name,
      customer_email,
      customer_phone,
      reservation_date,
      reservation_time,
      party_size,
      total_amount_kobo,
      notes,
    } = req.body || {};

    if (
      !customer_name ||
      !customer_email ||
      !reservation_date ||
      !reservation_time ||
      !party_size ||
      !total_amount_kobo
    ) {
      return res.status(400).json({ error: "Missing required booking fields" });
    }

    // Resolve or create business
    let effectiveBusinessId = business_id;

    if (!effectiveBusinessId) {
      if (!business_name) {
        return res
          .status(400)
          .json({ error: "Either business_id or business_name is required" });
      }

      const base = (subdomain || business_name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const slug = base || `biz-${Date.now()}`;

      // Look up existing business by subdomain first
      const existing = await query(
        "SELECT id FROM businesses WHERE subdomain = $1",
        [slug],
      );

      if (existing.rowCount > 0) {
        effectiveBusinessId = existing.rows[0].id;
        await query(
          "UPDATE businesses SET name = $1, email = $2 WHERE subdomain = $3",
          [business_name, customer_email, slug],
        );
      } else {
        const qrToken = crypto.randomBytes(32).toString("hex");
        const bizRes = await query(
          `INSERT INTO businesses (name, subdomain, email, qr_token)
           VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [business_name, slug, customer_email, qrToken],
        );
        effectiveBusinessId = bizRes.rows[0].id;
      }
    }

    const bookingResult = await query(
      `INSERT INTO bookings (
        business_id,
        customer_name,
        customer_email,
        customer_phone,
        reservation_date,
        reservation_time,
        party_size,
        notes,
        total_amount_kobo,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
      RETURNING *`,
      [
        effectiveBusinessId,
        customer_name,
        customer_email,
        customer_phone || null,
        reservation_date,
        reservation_time,
        party_size,
        notes || null,
        total_amount_kobo,
      ],
    );

    const booking = bookingResult.rows[0];
    console.log("[bookings] Created booking id=" + booking.id + " business_id=" + booking.business_id);
    return res.json({ booking });
  } catch (err) {
    console.error("[bookings.create] error", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to create booking" });
  }
});

// POST /api/bookings/:id/initiate-payment
// Uses existing booking to set up Paystack and create booking_payments record
router.post("/:id/initiate-payment", async (req, res) => {
  const { id } = req.params;
  console.log("[bookings] POST /" + id + "/initiate-payment");
  try {
    const bookingRes = await query(
      "SELECT * FROM bookings WHERE id = $1",
      [id],
    );
    if (bookingRes.rowCount === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }
    const booking = bookingRes.rows[0];

    const reference = createReference("reservation");

    // create booking_payments row
    await query(
      `INSERT INTO booking_payments (
        business_id,
        booking_id,
        paystack_reference,
        amount_kobo,
        status
      ) VALUES ($1,$2,$3,$4,'pending')`,
      [booking.business_id, booking.id, reference, booking.total_amount_kobo],
    );

    // Attach reference to booking
    await query(
      `UPDATE bookings SET paystack_reference = $1, status = 'awaiting_payment', updated_at = NOW()
       WHERE id = $2`,
      [reference, booking.id],
    );

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const callbackUrl = `${frontendUrl.replace(/\/$/, "")}/success?reference=${encodeURIComponent(reference)}`;

    const init = await initializeTransaction({
      email: booking.customer_email,
      amountKobo: booking.total_amount_kobo,
      reference,
      callbackUrl,
      metadata: {
        booking_id: booking.id,
        business_id: booking.business_id,
        customer_name: booking.customer_name,
      },
    });

    const authUrl = init?.data?.authorization_url;
    console.log("[bookings] Payment initiated reference=" + reference + " redirect=" + (authUrl ? "yes" : "no"));
    return res.json({
      booking_id: booking.id,
      reference,
      authorization_url: authUrl,
      access_code: init?.data?.access_code,
    });
  } catch (err) {
    console.error("[bookings.initiate-payment] error", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to initiate payment" });
  }
});

// Legacy combined endpoint kept for backwards compatibility
// POST /api/bookings/create-and-initiate-payment
// Body:
// {
//   "business_id": "uuid",
//   "customer_name": "...",
//   "customer_email": "...",
//   "customer_phone": "...",
//   "reservation_date": "2025-03-20",
//   "reservation_time": "19:30",
//   "party_size": 2,
//   "total_amount_kobo": 2500000,
//   "notes": "optional"
// }
router.post("/create-and-initiate-payment", async (req, res) => {
  try {
    const {
      business_id,
      customer_name,
      customer_email,
      customer_phone,
      reservation_date,
      reservation_time,
      party_size,
      total_amount_kobo,
      notes,
    } = req.body || {};

    if (
      !business_id ||
      !customer_name ||
      !customer_email ||
      !reservation_date ||
      !reservation_time ||
      !party_size ||
      !total_amount_kobo
    ) {
      return res.status(400).json({ error: "Missing required booking fields" });
    }

    // 1) Create booking row
    const bookingResult = await query(
      `INSERT INTO bookings (
        business_id,
        customer_name,
        customer_email,
        customer_phone,
        reservation_date,
        reservation_time,
        party_size,
        notes,
        total_amount_kobo,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
      RETURNING id`,
      [
        business_id,
        customer_name,
        customer_email,
        customer_phone || null,
        reservation_date,
        reservation_time,
        party_size,
        notes || null,
        total_amount_kobo,
      ],
    );

    const bookingId = bookingResult.rows[0].id;
    const reference = createReference("reservation");

    // 2) Create booking_payments row
    await query(
      `INSERT INTO booking_payments (
        business_id,
        booking_id,
        paystack_reference,
        amount_kobo,
        status
      ) VALUES ($1,$2,$3,$4,'pending')`,
      [business_id, bookingId, reference, total_amount_kobo],
    );

    // 3) Attach reference to booking for easier lookup
    await query(`UPDATE bookings SET paystack_reference = $1 WHERE id = $2`, [reference, bookingId]);

    // 4) Initialize Paystack transaction
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const callbackUrl = `${frontendUrl.replace(/\/$/, "")}/success?reference=${encodeURIComponent(reference)}`;
    const init = await initializeTransaction({
      email: customer_email,
      amountKobo: total_amount_kobo,
      reference,
      callbackUrl,
      metadata: {
        booking_id: bookingId,
        business_id,
        customer_name,
      },
    });

    return res.json({
      booking_id: bookingId,
      reference,
      authorization_url: init?.data?.authorization_url,
      access_code: init?.data?.access_code,
    });
  } catch (err) {
    console.error("[bookings.create-and-initiate-payment] error", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to create booking or initialize payment" });
  }
});

// GET /api/bookings/by-reference/:reference
// Returns booking + business name for success page (by Paystack reference)
router.get("/by-reference/:reference", async (req, res) => {
  const { reference } = req.params;
  console.log("[bookings] GET /by-reference/" + (reference ? String(reference).slice(0, 30) : ""));
  try {
    if (!reference) return res.status(400).json({ error: "reference is required" });

    const result = await query(
      `SELECT b.id, b.customer_name, b.customer_email, b.reservation_date, b.reservation_time,
              b.party_size, b.total_amount_kobo, b.notes, b.status, b.paystack_reference,
              biz.name AS business_name
       FROM bookings b
       LEFT JOIN businesses biz ON biz.id = b.business_id
       WHERE b.paystack_reference = $1`,
      [reference],
    );

    if (result.rowCount === 0) {
      console.log("[bookings] By-reference: not found");
      return res.status(404).json({ error: "Booking not found" });
    }

    const row = result.rows[0];
    console.log("[bookings] By-reference: found booking id=" + row.id);
    res.json({
      booking: {
        id: row.id,
        customer_name: row.customer_name,
        customer_email: row.customer_email,
        reservation_date: row.reservation_date,
        reservation_time: row.reservation_time,
        party_size: row.party_size,
        total_amount_kobo: row.total_amount_kobo,
        notes: row.notes,
        status: row.status,
        reference: row.paystack_reference,
        business_name: row.business_name || "—",
      },
    });
  } catch (err) {
    console.error("[bookings.by-reference] error", err?.message);
    return res.status(500).json({ error: "Failed to load booking" });
  }
});

export default router;

