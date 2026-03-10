import { Resend } from "resend";
import { buildReceiptPdf } from "./receiptPdf.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || "RepeatOS <onboarding@resend.dev>";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function formatAmountNg(n) {
  const ngn = Number(n) / 100;
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(ngn);
}

function formatDateForEmail(dateStr) {
  if (!dateStr) return "—";
  try {
    const dateOnly = String(dateStr).split("T")[0];
    const [y, m, d] = dateOnly.split("-").map(Number);
    if (!y || !m || !d) return dateOnly;
    return new Date(y, m - 1, d).toLocaleDateString("en-NG", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(dateStr);
  }
}

function formatTimeForEmail(timeStr) {
  if (!timeStr) return "—";
  try {
    const part = String(timeStr).split("+")[0].trim();
    const [h, min] = part.split(":").map(Number);
    if (h == null || min == null) return timeStr;
    const hour = h % 24;
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${String(min).padStart(2, "0")} ${ampm}`;
  } catch {
    return String(timeStr);
  }
}

/**
 * Send welcome email + PDF receipt after successful payment.
 * Uses Resend if RESEND_API_KEY is set; otherwise logs and returns error.
 * @returns {{ sent: boolean, error?: string }} sent true if email was sent; error is a short user-facing reason when not sent.
 */
export async function sendBookingConfirmationEmail(booking, payment) {
  const toEmail = booking?.customer_email || "?";
  const ref = booking?.paystack_reference || payment?.paystack_reference || "?";
  console.log("[email] ─── ATTEMPTING TO SEND ───");
  console.log("[email]   to:", toEmail);
  console.log("[email]   reference:", ref);

  const planName = (booking.notes || "").replace(/^Plan:\s*/i, "").trim() || "Subscription";
  const businessName = booking.business_name || "your business";
  const amount = formatAmountNg(payment.amount_kobo);
  const date = formatDateForEmail(booking.reservation_date);
  const time = formatTimeForEmail(booking.reservation_time);
  const reference = booking.paystack_reference || payment.paystack_reference || "";

  const subject = `You're in — your ${planName} receipt & what's next`;
  console.log("[email]   subject:", subject);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're in — Welcome to RepeatOS</title>
</head>
<body style="margin:0; padding:0; background:#f6f5f1; font-family: system-ui, -apple-system, sans-serif;">
  <div style="max-width:560px; margin:0 auto; padding:40px 20px;">
    <div style="background:#0a0a0a; color:#f6f5f1; border-radius:16px; padding:36px 28px; box-shadow:0 24px 48px rgba(0,0,0,.15);">
      <p style="margin:0 0 8px; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:rgba(246,245,241,.5);">RepeatOS</p>
      <h1 style="margin:0 0 20px; font-size:26px; font-weight:600; letter-spacing:-0.5px; color:#f6f5f1;">You're in — welcome.</h1>
      <p style="margin:0 0 20px; font-size:16px; line-height:1.65; color:rgba(246,245,241,.9);">
        Hi ${escapeHtml(booking.customer_name)},
      </p>
      <p style="margin:0 0 20px; font-size:15px; line-height:1.7; color:rgba(246,245,241,.85);">
        You just invested in your business. That matters to us. Thank you for choosing RepeatOS — we're glad you're here.
      </p>
      <p style="margin:0 0 24px; font-size:15px; line-height:1.7; color:rgba(246,245,241,.85);">
        Your payment was successful and your plan is active. We've attached your official receipt to this email so you have everything in one place.
      </p>
      <table style="width:100%; border-collapse:collapse; background:rgba(255,255,255,.06); border-radius:12px; border:1px solid rgba(255,255,255,.1); margin-bottom:28px;">
        <tr><td style="padding:18px 20px; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:rgba(246,245,241,.5);" colspan="2">Payment summary</td></tr>
        <tr><td style="padding:8px 20px; font-size:13px; color:rgba(246,245,241,.6);">Business</td><td style="padding:8px 20px; font-size:14px; font-weight:500; color:rgba(246,245,241,.95);">${escapeHtml(businessName)}</td></tr>
        <tr><td style="padding:8px 20px; font-size:13px; color:rgba(246,245,241,.6);">Plan</td><td style="padding:8px 20px; font-size:14px; font-weight:500; color:rgba(246,245,241,.95);">${escapeHtml(planName)}</td></tr>
        <tr><td style="padding:8px 20px; font-size:13px; color:rgba(246,245,241,.6);">Amount paid</td><td style="padding:8px 20px; font-size:14px; font-weight:500; color:rgba(246,245,241,.95);">${escapeHtml(amount)}</td></tr>
        <tr><td style="padding:8px 20px; font-size:13px; color:rgba(246,245,241,.6);">Reference</td><td style="padding:8px 20px; font-size:12px; font-weight:500; color:rgba(246,245,241,.8); word-break:break-all;">${escapeHtml(reference)}</td></tr>
      </table>
      <div style="border-left:3px solid rgba(246,245,241,.35); padding:16px 20px; margin-bottom:24px; background:rgba(255,255,255,.03); border-radius:0 8px 8px 0;">
        <p style="margin:0 0 10px; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; color:rgba(246,245,241,.6); font-weight:600;">What happens next</p>
        <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:rgba(246,245,241,.88);">We'll reach out to you shortly at this email to say hello and guide you through the next steps.</p>
        <p style="margin:0; font-size:14px; line-height:1.6; color:rgba(246,245,241,.8);">We'll also ask a few more questions about what you want — not everything in one go — so we can tailor your setup to your business and your customers.</p>
      </div>
      <p style="margin:0 0 8px; font-size:13px; color:rgba(246,245,241,.7);">📎 Your receipt is attached as a PDF. Keep it for your records.</p>
      <p style="margin:0; font-size:13px; color:rgba(246,245,241,.55);">
        Any questions? Just reply to this email — we're here.
      </p>
    </div>
  </div>
</body>
</html>
`.trim();

  console.log("[email] Step 1: Building PDF receipt...");
  let pdfBuffer = null;
  try {
    pdfBuffer = await buildReceiptPdf(booking, payment);
    console.log("[email] Step 1: PDF receipt built successfully (" + (pdfBuffer ? pdfBuffer.length : 0) + " bytes)");
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[email] Step 1: PDF receipt build FAILED:", msg);
    console.error("[email]   → Reason: receipt generation threw —", msg);
    return { sent: false, error: "Receipt could not be generated. " + (msg || "Unknown error.") };
  }

  const receiptFilename = `RepeatOS-Receipt-${(reference || "payment").replace(/[^a-z0-9_-]/gi, "-")}.pdf`;

  if (!resend) {
    const reason = "RESEND_API_KEY is not set in backend/.env.";
    console.warn("[email] Step 2: Email NOT sent — Resend is not configured.");
    console.warn("[email]   → Reason:", reason);
    console.warn("[email]   → Would have sent to:", booking.customer_email, "| subject:", subject);
    console.log("[email] ─── END (not sent) ───");
    return { sent: false, error: "Email is not configured. Add RESEND_API_KEY in server environment." };
  }

  const attachments = [];
  if (pdfBuffer && pdfBuffer.length) {
    attachments.push({
      filename: receiptFilename,
      content: pdfBuffer,
    });
  }
  console.log("[email] Step 2: Sending via Resend (from:", FROM_EMAIL, ", attachments:", attachments.length, ")...");

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: booking.customer_email,
      subject,
      html,
      attachments: attachments.length ? attachments : undefined,
    });
    if (error) {
      const errMsg = typeof error === "object" ? (error.message || JSON.stringify(error)) : String(error);
      console.error("[email] Step 2: Resend API returned an error (email NOT sent).");
      console.error("[email]   → Resend error:", errMsg);
      if (typeof error === "object" && error.message) {
        console.error("[email]   → Message:", error.message);
      }
      console.log("[email] ─── END (not sent) ───");
      return { sent: false, error: errMsg || "Resend rejected the email." };
    }
    console.log("[email] Step 2: Email sent successfully.");
    console.log("[email]   → Resend id:", data?.id || "(none)");
    console.log("[email] ─── END (sent) ───");
    return { sent: true };
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[email] Step 2: Send threw (email NOT sent):", msg);
    console.error("[email]   → Exception:", err);
    console.log("[email] ─── END (not sent) ───");
    return { sent: false, error: msg || "Network or server error while sending." };
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
