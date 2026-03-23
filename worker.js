/**
 * Cloudflare Worker — Fuel Price Proxy (Daily Updates)
 *
 * Scrapes FREE, public fuel price data from the Australian Institute
 * of Petroleum (AIP). No API key, no signup, no cost.
 *
 * ── STRATEGY ──
 * The AIP publishes two Brisbane ULP datasets:
 *   1. Terminal Gate Prices (TGP) — daily wholesale, updated each weekday
 *   2. QLD Retail Table — weekly average pump price
 *
 * We use BOTH to produce a calibrated daily retail estimate:
 *   - Fetch TGP table → get the latest 5 weekdays of wholesale prices
 *   - Fetch retail table → get the latest weekly average pump price
 *   - Calculate the retail-vs-wholesale offset (can be negative —
 *     retailers often sell below TGP during the discount phase of
 *     the fuel price cycle)
 *   - Today's estimated retail = today's TGP + calibrated offset
 *
 * This gives daily price movement from TGP, anchored to real pump
 * prices via the weekly retail figure.
 *
 * ── DEPLOY ──
 * 1. npm install -g wrangler && wrangler login
 * 2. wrangler init fuel-price-worker
 * 3. Copy this file to src/index.js
 * 4. wrangler deploy
 * No secrets. No API keys.
 */

const CACHE_TTL = 14400;      // 4 hours — TGP updates once per weekday morning
const FALLBACK_PRICE = 235;   // cents/L fallback — update occasionally

const ALLOWED_ORIGINS = [
  'https://fuelrealitycheck.com.au',
  'https://www.fuelrealitycheck.com.au',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'null',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Parse ALL Brisbane TGP prices from the AIP TGP table.
 * Returns an array of { date, price } objects (most recent last),
 * or empty array on failure. Prices in cents/L.
 */
function parseTGPPrices(html) {
  const results = [];

  // Extract the header row dates
  // Pattern: <th>... Day DD Month YYYY ...</th>
  const dateMatches = [...html.matchAll(
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2}\s+\w+\s+\d{4})/gi
  )];

  // Find the Petrol (ULP) section — it's the first table
  // Brisbane row pattern: brisbaneUlp link followed by price cells
  const brisbaneMatch = html.match(
    /brisbaneUlp[^<]*<\/a>\s*<\/td>([\s\S]*?)<\/tr>/i
  );
  if (!brisbaneMatch) return results;

  const priceCells = [...brisbaneMatch[1].matchAll(
    /<td[^>]*>\s*([\d.]+|n\.a\.|-)\s*<\/td>/gi
  )];

  for (let i = 0; i < priceCells.length; i++) {
    const raw = priceCells[i][1];
    if (raw === 'n.a.' || raw === '-') continue;

    const price = parseFloat(raw);
    if (price > 100 && price < 400) {
      const dateStr = dateMatches[i]
        ? dateMatches[i][1]
        : `Day ${i + 1}`;
      results.push({ date: dateStr, price });
    }
  }

  return results;
}

/**
 * Parse Brisbane weekly retail price from AIP QLD retail table.
 * Returns price in cents/L or null.
 */
function parseRetailPrice(html) {
  const match = html.match(
    /Brisbane<\/a>\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i
  );
  if (match) {
    const price = parseFloat(match[1]);
    if (price > 100 && price < 400) return price;
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // ── Check cache ──
      const cache = caches.default;
      const cacheKey = new Request('https://cache.internal/fuel-price/brisbane/u91/v3-daily');
      const cached = await cache.match(cacheKey);

      if (cached) {
        const body = await cached.text();
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
            ...corsHeaders(origin),
          },
        });
      }

      // ── Fetch both sources in parallel ──
      const [tgpResp, retailResp] = await Promise.allSettled([
        fetch('http://api.aip.com.au/public/tgpTables', {
          headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
        }),
        fetch('http://api.aip.com.au/public/qldUlpTable', {
          headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
        }),
      ]);

      let tgpPrices = [];
      let retailPrice = null;

      if (tgpResp.status === 'fulfilled' && tgpResp.value.ok) {
        const html = await tgpResp.value.text();
        tgpPrices = parseTGPPrices(html);
      }

      if (retailResp.status === 'fulfilled' && retailResp.value.ok) {
        const html = await retailResp.value.text();
        retailPrice = parseRetailPrice(html);
      }

      // ── Calculate calibrated daily price ──
      let finalCents;
      let source;
      let offset = null;

      const latestTGP = tgpPrices.length > 0
        ? tgpPrices[tgpPrices.length - 1].price
        : null;
      const earliestTGP = tgpPrices.length > 0
        ? tgpPrices[0].price
        : null;

      if (latestTGP && retailPrice) {
        // Best case: both sources available.
        // The retail figure covers the prior week. The earliest TGP
        // in the table is from the start of the current week, which
        // roughly overlaps. Use that to calibrate.
        offset = retailPrice - earliestTGP;
        finalCents = Math.round(latestTGP + offset);
        source = 'aip-daily-calibrated';
      } else if (latestTGP) {
        // TGP only — apply a small default margin.
        // In practice retail often sits slightly below TGP due to
        // competitive discounting, so we use -3c/L as a conservative
        // offset rather than adding margin.
        offset = -3;
        finalCents = Math.round(latestTGP + offset);
        source = 'aip-tgp-estimated';
      } else if (retailPrice) {
        // Retail only — weekly, but better than nothing
        finalCents = Math.round(retailPrice);
        source = 'aip-retail-weekly';
      } else {
        finalCents = FALLBACK_PRICE;
        source = 'fallback';
      }

      // Sanity clamp
      if (finalCents < 100) finalCents = FALLBACK_PRICE;
      if (finalCents > 400) finalCents = FALLBACK_PRICE;

      const responseData = {
        status: source === 'fallback' ? 'fallback' : 'ok',
        city: 'brisbane',
        fuel_type: 'U91',
        price_per_litre: parseFloat((finalCents / 100).toFixed(3)),
        price_cents_per_litre: finalCents,
        source,
        calibration: {
          retail_weekly: retailPrice,
          tgp_latest: latestTGP,
          tgp_earliest: earliestTGP,
          offset,
        },
        tgp_history: tgpPrices,
        fetched_at: new Date().toISOString(),
      };

      const body = JSON.stringify(responseData);

      // ── Cache ──
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      })));

      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          ...corsHeaders(origin),
        },
      });

    } catch (error) {
      const fallback = {
        status: 'fallback',
        city: 'brisbane',
        fuel_type: 'U91',
        price_per_litre: FALLBACK_PRICE / 100,
        price_cents_per_litre: FALLBACK_PRICE,
        source: 'fallback',
        error: error.message,
        fetched_at: new Date().toISOString(),
      };

      return new Response(JSON.stringify(fallback), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          ...corsHeaders(origin),
        },
      });
    }
  },
};
