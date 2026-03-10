import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const {
  PAYSTACK_SECRET_KEY,
  PAYSTACK_BASE_URL = "https://api.paystack.co",
} = process.env;

if (!PAYSTACK_SECRET_KEY) {
  // In dev this will just log; in prod you should fail fast on startup.
  console.warn("[paystack] PAYSTACK_SECRET_KEY is not set. Payments will fail.");
}

const client = axios.create({
  baseURL: PAYSTACK_BASE_URL,
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

export async function initializeTransaction({ email, amountKobo, reference, metadata = {}, callbackUrl }) {
  console.log("[paystack] Initialize transaction reference=" + reference + " amount_kobo=" + amountKobo);
  const payload = {
    email,
    amount: amountKobo,
    reference,
    currency: "NGN",
    metadata,
  };
  if (callbackUrl) payload.callback_url = callbackUrl;

  const { data } = await client.post("/transaction/initialize", payload);
  console.log("[paystack] Initialize ok authorization_url=" + (data?.data?.authorization_url ? "yes" : "no"));
  return data;
}

export async function verifyTransaction(reference) {
  const { data } = await client.get(`/transaction/verify/${reference}`);
  return data;
}

export async function chargeAuthorization({ email, authorizationCode, amountKobo, reference, metadata = {} }) {
  console.log("[paystack] Charge authorization reference=" + reference + " amount_kobo=" + amountKobo);
  const payload = {
    email,
    authorization_code: authorizationCode,
    amount: amountKobo,
    reference,
    currency: "NGN",
    metadata,
  };
  const { data } = await client.post("/transaction/charge_authorization", payload);
  return data;
}

