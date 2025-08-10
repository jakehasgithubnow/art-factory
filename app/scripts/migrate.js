// scripts/migrate.js
import fs from 'node:fs/promises';
import pg from 'pg';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = await fs.readFile(new URL('../app/db/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log('Schema applied ✅');
} finally {
  await client.end();
}