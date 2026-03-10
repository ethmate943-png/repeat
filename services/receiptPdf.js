import PDFDocument from "pdfkit";

function formatAmountNg(n) {
  const ngn = Number(n) / 100;
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(ngn);
}

function formatDateForPdf(dateStr) {
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

function formatTimeForPdf(timeStr) {
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
 * Build a PDF receipt for the booking/payment. Returns a Buffer.
 * Matches the email theme (dark background, same fields) for uniformity.
 */
export function buildReceiptPdf(booking, payment) {
  const planName =
    (booking.notes || "").replace(/^Plan:\s*/i, "").trim() || "Subscription";
  const businessName = booking.business_name || "—";
  const amount = formatAmountNg(payment.amount_kobo);
  const date = formatDateForPdf(booking.reservation_date);
  const time = formatTimeForPdf(booking.reservation_time);
  const reference = booking.paystack_reference || payment.paystack_reference || "";

  const monthlyMap = {
    "Starter": "₦35,000/mo",
    "Growth": "₦50,000/mo",
    "Authority": "₦75,000/mo",
    "Loyalty Add-On": "₦40,000/mo",
  };
  const monthlyLabel = monthlyMap[planName] || null;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const pageWidth = 595 - 96;
    const cardPadding = 24;

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Dark card background (matches email theme)
    const cardTop = 0;
    const cardHeight = 700;
    doc.rect(0, cardTop, 595, cardHeight).fill("#0a0a0a");

    // Content area (with padding)
    const left = 48 + cardPadding;
    const right = 595 - 48 - cardPadding;
    const width = right - left;
    let y = 48 + cardPadding;

    const textPrimary = "#f6f5f1";
    const textMuted = "#9c9b97";
    const textSub = "#b8b7b2";
    const borderLight = "#2a2a2a";
    const blockBg = "#141414";

    // Brand
    doc.fontSize(10).fillColor(textMuted).text("REPEATOS", left, y, { characterSpacing: 2 });
    y += 22;
    doc.fontSize(24).fillColor(textPrimary).text("Payment receipt", left, y);
    y += 36;

    // Subheading
    doc.fontSize(12).fillColor(textSub).text("Subscription confirmed — keep this for your records.", left, y);
    y += 28;

    // Divider
    doc.rect(left, y, width, 1).fillColor(borderLight).fill();
    y += 24;

    // Payment summary block (matches email summary table)
    const summaryTop = y;
    const summaryHeight = 14 + 8 * 22 + 14;
    doc.rect(left, summaryTop, width, summaryHeight).fillColor(blockBg).fill();
    doc.rect(left, summaryTop, width, summaryHeight).strokeColor(borderLight).stroke();
    y += 14;
    doc.fontSize(9).fillColor(textMuted).text("PAYMENT SUMMARY", left, y, { characterSpacing: 1.5 });
    y += 22;

    const labelX = left;
    const valueX = right - 8;
    const valueWidth = 200;

    function pdfRow(label, value) {
      doc.fontSize(10).fillColor(textMuted).text(label, labelX, y);
      doc.fontSize(10).fillColor(textPrimary).text(String(value), valueX, y, { width: valueWidth, align: "right" });
      y += 22;
    }

    pdfRow("Business", businessName);
    pdfRow("Plan", planName);
    pdfRow("Date", date);
    pdfRow("Time", time);
    pdfRow("Party size", booking.party_size || "—");
    pdfRow("Amount paid (setup)", amount);
    if (monthlyLabel) {
      pdfRow("Monthly infrastructure", monthlyLabel);
    }
    doc.fontSize(10).fillColor(textMuted).text("Reference", labelX, y);
    doc.fontSize(9).fillColor(textSub).text(reference, valueX, y, { width: valueWidth, align: "right" });
    y += 28;

    // What's next (same message as email)
    y += 16;
    doc.rect(left, y, 4, 50).fillColor("#3a3a3a").fill();
    y += 10;
    doc.fontSize(9).fillColor(textMuted).text("WHAT HAPPENS NEXT", left + 14, y, { characterSpacing: 1 });
    y += 16;
    doc.fontSize(10).fillColor(textSub).text("We'll contact you at this email to guide you through the next steps and ask a few more questions about what you want — so we can tailor your setup.", left + 14, y, { width: width - 20, align: "left" });
    y += 48;

    // Footer
    doc.fontSize(9).fillColor(textMuted).text("Thank you for choosing RepeatOS. Any questions? Reply to your confirmation email.", left, y, { width, align: "left" });

    doc.end();
  });
}
