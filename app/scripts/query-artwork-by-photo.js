// scripts/query-artwork-by-photo.js
// Usage: node scripts/query-artwork-by-photo.js <photoId-uuid>
import pg from 'pg';
import { env } from '../config/env.js';

async function main() {
  const photoId = process.argv[2];
  if (!photoId) {
    console.error('Usage: node scripts/query-artwork-by-photo.js <photoId-uuid>');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `
      select
        id,
        photo_id,
        style_prompt_id,
        style_name,
        approved_for_publish,
        moderated_at,
        published,
        created_at,
        image_url
      from artwork
      where photo_id = $1
      order by created_at desc
      `,
      [photoId]
    );
    console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('query-artwork-by-photo failed:', err);
  process.exit(1);
});
