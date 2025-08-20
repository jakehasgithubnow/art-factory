// scripts/run-sql.js
// Usage: node scripts/run-sql.js path/to/file.sql
import fs from 'node:fs/promises';
import pg from 'pg';
import { env } from '../config/env.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/run-sql.js path/to/file.sql');
    process.exit(1);
  }
  const sql = await fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Applied SQL from ${file} ✅`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('run-sql failed:', err);
  process.exit(1);
});
