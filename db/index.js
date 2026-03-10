import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  console.warn("[db] DATABASE_URL is not set. Database calls will fail.");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

export async function query(text, params) {
  return pool.query(text, params);
}

