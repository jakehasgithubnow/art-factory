import knexFn from 'knex';
import { env } from '../config/env.js';

export default knexFn({
  client: 'pg',
  connection: env.databaseUrl,
  migrations: { tableName: 'knex_migrations' }
});
