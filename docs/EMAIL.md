# How we send emails

Confirmation emails (welcome + PDF receipt) are sent from the **backend** using **Resend**.

## Service

- **File:** `backend/services/email.js`
- **Function:** `sendBookingConfirmationEmail(booking, payment)`
- **Provider:** Resend (`RESEND_API_KEY` in `backend/.env`)
- **From:** `EMAIL_FROM` in `backend/.env` (e.g. `RepeatOS <onboarding@resend.dev>`)
- **To:** `booking.customer_email`
- **Content:** HTML welcome body + attached PDF receipt (built in `receiptPdf.js`)

If `RESEND_API_KEY` is not set, the function still runs but only logs to the server console; no email is sent.

## When emails are sent

1. **Automatically (webhook)**  
   Paystack sends a `charge.success` webhook to `POST /api/payments/webhooks/paystack`.  
   The backend looks up the booking by Paystack reference, marks the payment/booking as paid, then calls `sendBookingConfirmationEmail(booking, payment)`.  
   **Note:** In local dev, Paystack cannot reach `localhost`. Use a tunnel (e.g. ngrok) and set that URL in the Paystack dashboard for the webhook to run.

2. **Manually (for testing)**  
   `POST /api/payments/send-confirmation` with body `{ "reference": "reservation_xxxx_..." }` (the Paystack reference).  
   The backend loads the booking and calls `sendBookingConfirmationEmail`. Use this when testing locally without webhooks.

## Logs

- On every send attempt: `[email] ATTEMPTING TO SEND — to: <email> reference: <reference>`
- After building PDF: `[email] PDF receipt built … bytes`
- On success: `[email] Sent to <email> id=…`
- On missing API key: `[email] EMAIL NOT SENT — set RESEND_API_KEY in backend/.env`

If you never see `ATTEMPTING TO SEND` in the server console, the email function is never being called (e.g. webhook not hitting your server or send-confirmation not used).
