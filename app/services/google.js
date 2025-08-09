import fetch from 'node-fetch';
import { env } from '../config/env.js';

export async function imageSearch(query, num = 20) {
  const qs = new URLSearchParams({
    key: env.googleKey,
    cx: env.googleCseId,
    searchType: 'image',
    q: query,
    num
  });
  const res = await fetch(`https://customsearch.googleapis.com/customsearch/v1?${qs}`);
  const { items = [] } = await res.json();
  return items.map(i => ({ url: i.link, context: i.image?.contextLink }));
}