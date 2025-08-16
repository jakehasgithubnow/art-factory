// scripts/migrate.js
import fs from 'node:fs/promises';
import pg from 'pg';

import { env } from '../config/env.js';

const sql = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: env.databaseUrl });
await client.connect();
try {
  await client.query(sql);
  console.log('Schema applied ✅');
} finally {
  await client.end();
}
