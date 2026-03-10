import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./index.js";

async function main() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const schemaPath = path.join(__dirname, "schema.sql");
    const sql = await fs.readFile(schemaPath, "utf8");

    await pool.query(sql);
    console.log("[migrate] schema applied successfully");
  } catch (err) {
    console.error("[migrate] error applying schema:", err.message);
  } finally {
    await pool.end();
  }
}

main();

