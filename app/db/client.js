import knexFn from 'knex';
import { env } from '../config/env.js';

const db = knexFn({
  client: 'pg',
  connection: env.databaseUrl,
  migrations: { tableName: 'knex_migrations' }
});

export default db;
