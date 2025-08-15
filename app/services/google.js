import fetch from 'node-fetch';

// Restore imageSearch alongside new getPlaceDetails

/**
 * Search Google Images (Custom Search API) for a query and return results.
 * Expects GOOGLE_API_KEY and GOOGLE_CX in environment variables.
 */
export async function imageSearch(query, num = 10) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!apiKey || !cx) {
    throw new Error('Google API key (GOOGLE_API_KEY) or CX (GOOGLE_CX) not set');
  }
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&searchType=image&num=${num}&key=${apiKey}&cx=${cx}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.items) return [];
    return data.items.map(item => ({
      url: item.link,
      thumbnail: item.image?.thumbnailLink,
      contextLink: item.image?.contextLink,
      mime: item.mime,
      width: item.image?.width,
      height: item.image?.height
    }));
  } catch (err) {
    console.error('[Google imageSearch] Error:', err);
    return [];
  }
}

// Add Google Places enrichment utility

/**
 * Fetch detailed Google Places data for a given search term.
 * 1. Text Search to find place_id
 * 2. Place Details to get structured info
 */
export async function getPlaceDetails(searchTerm) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.warn('[Google Places] API key not set in GOOGLE_PLACES_API_KEY');
    return null;
  }
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  try {
    // Step 1: Text Search
    const textUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchTerm)}&key=${apiKey}`;
    const textRes = await fetch(textUrl);
    const textData = await textRes.json();
    if (!textData.results || !textData.results.length) {
      console.warn('[Google Places] No results for', searchTerm);
      return null;
    }
    const placeId = textData.results[0].place_id;
    if (!placeId) {
      console.warn('[Google Places] Missing place_id for', searchTerm);
      return null;
    }

    // Step 2: Place Details
    const fields = [
      'name',
      'formatted_address',
      'international_phone_number',
      'website',
      'geometry',
      'opening_hours',
      'rating',
      'user_ratings_total',
      'types',
      'photos'
    ].join(',');
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
    const detailRes = await fetch(detailUrl);
    const detailData = await detailRes.json();
    if (detailData.status !== 'OK' || !detailData.result) {
      console.warn('[Google Places] Place Details fetch failed for', searchTerm, detailData.status);
      return null;
    }

    const r = detailData.result;
    return {
      g_place_id: placeId,
      g_name: r.name || null,
      g_formatted_address: r.formatted_address || null,
      g_phone: r.international_phone_number || null,
      g_website: r.website || null,
      g_lat: r.geometry?.location?.lat ?? null,
      g_lng: r.geometry?.location?.lng ?? null,
      g_rating: r.rating ?? null,
      g_user_ratings_total: r.user_ratings_total ?? null,
      g_types: Array.isArray(r.types) ? r.types.join(',') : null,
      g_photo_refs: Array.isArray(r.photos) ? r.photos.map(p => p.photo_reference) : []
    };
  } catch (err) {
    console.error('[Google Places] Error fetching details for', searchTerm, err);
    return null;
  }
}
