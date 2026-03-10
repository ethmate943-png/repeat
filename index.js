import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import paymentsRouter from "./routes/payments.js";
import bookingsRouter from "./routes/bookings.js";
import subscriptionsRouter from "./routes/subscriptions.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

const allowedOrigins = ["http://localhost:3000", "https://userepeatos.com"];

// Request logging
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Bookings + Paystack routes
app.use("/api/bookings", bookingsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/subscriptions", subscriptionsRouter);

app.listen(PORT, () => {
  console.log("[server] RepeatOS backend listening on http://localhost:" + PORT);
  console.log("[server] Health: GET /health | Bookings: /api/bookings | Payments: /api/payments | Subscriptions: /api/subscriptions");
});

