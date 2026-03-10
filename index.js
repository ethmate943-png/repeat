import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import paymentsRouter from "./routes/payments.js";
import bookingsRouter from "./routes/bookings.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// Request logging
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

// JSON parsing for normal routes
app.use(express.json());
app.use(cors());

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Bookings + Paystack routes
app.use("/api/bookings", bookingsRouter);
app.use("/api/payments", paymentsRouter);

app.listen(PORT, () => {
  console.log("[server] RepeatOS backend listening on http://localhost:" + PORT);
  console.log("[server] Health: GET /health | Bookings: /api/bookings | Payments: /api/payments");
});

