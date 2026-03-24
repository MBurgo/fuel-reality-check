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
  'https://fuel-reality-check.pages.dev',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'null',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Parse Brisbane TGP prices from a section of the AIP TGP table.
 * @param {string} html - HTML content to search
 * @param {string} fuelKey - 'brisbaneUlp' or 'brisbaneDiesel'
 * Returns an array of { date, price } objects (most recent last),
 * or empty array on failure. Prices in cents/L.
 */
function parseTGPPrices(html, fuelKey = 'brisbaneUlp') {
  const results = [];

  const brisbaneMatch = html.match(
    new RegExp(fuelKey + '[\\s\\S]*?<\\/th>([\\s\\S]*?)<\\/tr>', 'i')
  );
  if (!brisbaneMatch) return results;

  const priceCells = [...brisbaneMatch[1].matchAll(
    /<td[^>]*>\s*([\d.]+)\s*<\/td>/gi
  )];

  for (const cell of priceCells) {
    const price = parseFloat(cell[1]);
    if (price > 100 && price < 400) {
      results.push({ date: `Day ${results.length + 1}`, price });
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
    /Brisbane<\/a>\s*<\/t[hd]>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i
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
      // ── No caching — fetch fresh from AIP each request ──
      // AIP pages are small (~24KB) and we're on Cloudflare's free tier
      // (100k req/day). Simpler and avoids all cache-busting headaches.

      // Try TGP with http (https returns 526 from AIP)
      const tgpUrls = [
        'http://api.aip.com.au/public/tgpTables',
      ];

      const [retailResp, dieselRetailResp] = await Promise.all([
        fetch('http://api.aip.com.au/public/qldUlpTable', {
          headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
        }).catch(() => null),
        fetch('http://api.aip.com.au/public/qldDieselTable?fuelType=Diesel', {
          headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
        }).catch(() => null),
      ]);

      let tgpPrices = [];
      let dieselTgpPrices = [];
      let tgpError = null;
      let tgpDebugAll = [];

      for (const url of tgpUrls) {
        try {
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
            redirect: 'follow',
          });
          const finalUrl = resp.url || url;
          const status = resp.status;
          
          if (resp.ok) {
            const html = await resp.text();
            const hasBrisbane = html.includes('brisbaneUlp');
            const hasDiesel = html.includes('brisbaneDiesel');
            const hasTGP = html.includes('Terminal Gate');
            tgpPrices = parseTGPPrices(html, 'brisbaneUlp');
            dieselTgpPrices = parseTGPPrices(html, 'brisbaneDiesel');
            
            tgpDebugAll.push({
              url,
              finalUrl,
              status,
              bytes: html.length,
              hasBrisbane,
              hasDiesel,
              hasTGP,
              petrolPricesFound: tgpPrices.length,
              dieselPricesFound: dieselTgpPrices.length,
            });
            
            if (tgpPrices.length > 0) break;
          } else {
            tgpDebugAll.push({ url, finalUrl, status, error: 'not ok' });
          }
        } catch (e) {
          tgpDebugAll.push({ url, error: e.message });
        }
      }

      let retailPrice = null;
      if (retailResp && retailResp.ok) {
        const html = await retailResp.text();
        retailPrice = parseRetailPrice(html);
      }

      let dieselRetailPrice = null;
      if (dieselRetailResp && dieselRetailResp.ok) {
        const html = await dieselRetailResp.text();
        dieselRetailPrice = parseRetailPrice(html);
      }

      // ── Calculate calibrated daily price for PETROL ──
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

      // ── Calculate calibrated daily price for DIESEL ──
      let dieselFinalCents;
      let dieselSource;
      let dieselOffset = null;

      const dieselLatestTGP = dieselTgpPrices.length > 0
        ? dieselTgpPrices[dieselTgpPrices.length - 1].price
        : null;
      const dieselEarliestTGP = dieselTgpPrices.length > 0
        ? dieselTgpPrices[0].price
        : null;

      if (dieselLatestTGP && dieselRetailPrice) {
        dieselOffset = dieselRetailPrice - dieselEarliestTGP;
        dieselFinalCents = Math.round(dieselLatestTGP + dieselOffset);
        dieselSource = 'aip-daily-calibrated';
      } else if (dieselLatestTGP) {
        dieselOffset = -3;
        dieselFinalCents = Math.round(dieselLatestTGP + dieselOffset);
        dieselSource = 'aip-tgp-estimated';
      } else if (dieselRetailPrice) {
        dieselFinalCents = Math.round(dieselRetailPrice);
        dieselSource = 'aip-retail-weekly';
      } else {
        // Fallback: diesel is typically ~15% more than petrol
        dieselFinalCents = Math.round(finalCents * 1.15);
        dieselSource = 'estimated-from-petrol';
      }

      if (dieselFinalCents < 100) dieselFinalCents = Math.round(FALLBACK_PRICE * 1.15);
      if (dieselFinalCents > 500) dieselFinalCents = Math.round(FALLBACK_PRICE * 1.15);

      const responseData = {
        status: source === 'fallback' ? 'fallback' : 'ok',
        city: 'brisbane',
        // Petrol (backwards-compatible fields)
        fuel_type: 'U91',
        price_per_litre: parseFloat((finalCents / 100).toFixed(3)),
        price_cents_per_litre: finalCents,
        source,
        // Diesel
        diesel_price_cents_per_litre: dieselFinalCents,
        diesel_source: dieselSource,
        calibration: {
          petrol: {
            retail_weekly: retailPrice,
            tgp_latest: latestTGP,
            tgp_earliest: earliestTGP,
            offset,
          },
          diesel: {
            retail_weekly: dieselRetailPrice,
            tgp_latest: dieselLatestTGP,
            tgp_earliest: dieselEarliestTGP,
            offset: dieselOffset,
          },
        },
        tgp_history: { petrol: tgpPrices, diesel: dieselTgpPrices },
        tgp_debug: tgpDebugAll,
        fetched_at: new Date().toISOString(),
      };

      const body = JSON.stringify(responseData);

      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
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
