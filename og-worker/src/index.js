import { ImageResponse } from 'workers-og';

const FALLBACK_PRICE = 254;

function seeded(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getDayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 864e5);
}

// ── AIP price scraping (same logic as price worker) ──

function parseTGPPrices(html) {
  const results = [];
  const brisbaneMatch = html.match(/brisbaneUlp[\s\S]*?<\/th>([\s\S]*?)<\/tr>/i);
  if (!brisbaneMatch) return results;
  const priceCells = [...brisbaneMatch[1].matchAll(/<td[^>]*>\s*([\d.]+)\s*<\/td>/gi)];
  for (const cell of priceCells) {
    const price = parseFloat(cell[1]);
    if (price > 100 && price < 400) results.push(price);
  }
  return results;
}

function parseRetailPrice(html) {
  const match = html.match(/Brisbane<\/a>\s*<\/t[hd]>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i);
  if (match) {
    const price = parseFloat(match[1]);
    if (price > 100 && price < 400) return price;
  }
  return null;
}

async function fetchLivePrice() {
  let tgpPrices = [];
  let retailPrice = null;

  try {
    const resp = await fetch('http://api.aip.com.au/public/tgpTables', {
      headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
    });
    if (resp.ok) {
      const html = await resp.text();
      tgpPrices = parseTGPPrices(html);
    }
  } catch (e) { /* continue */ }

  try {
    const resp = await fetch('http://api.aip.com.au/public/qldUlpTable', {
      headers: { 'User-Agent': 'FuelRealityCheck/1.0' },
    });
    if (resp.ok) {
      const html = await resp.text();
      retailPrice = parseRetailPrice(html);
    }
  } catch (e) { /* continue */ }

  const latestTGP = tgpPrices.length > 0 ? tgpPrices[tgpPrices.length - 1] : null;
  const earliestTGP = tgpPrices.length > 0 ? tgpPrices[0] : null;

  if (latestTGP && retailPrice) {
    const offset = retailPrice - earliestTGP;
    return Math.round(latestTGP + offset);
  } else if (latestTGP) {
    return Math.round(latestTGP - 3);
  } else if (retailPrice) {
    return Math.round(retailPrice);
  }
  return FALLBACK_PRICE;
}

// ── Items ──

const ITEMS = [
  { name: "Two Live Lobsters", price: 95 },
  { name: "A Case of Wine", price: 100 },
  { name: "10 Large Pizzas", price: 99 },
  { name: "20 Flat Whites", price: 100 },
  { name: "A New Video Game", price: 99 },
  { name: "12 Rotisserie Chickens", price: 96 },
  { name: "16 Movie Tickets", price: 96 },
  { name: "48 Tacos", price: 96 },
  { name: "A Banjo", price: 99 },
  { name: "100 Scratchie Tickets", price: 100 },
  { name: "Noise-Cancelling Headphones", price: 124 },
  { name: "A Robot Vacuum", price: 125 },
  { name: "A Premium Cookware Set", price: 129 },
  { name: "An Electric Guitar", price: 135 },
  { name: "A Dog Training Course", price: 145 },
  { name: "A Wetsuit", price: 148 },
  { name: "A Wine Tasting Weekend", price: 150 },
  { name: "Adjustable Dumbbells", price: 155 },
  { name: "A Violin", price: 157 },
  { name: "A Carry-On Suitcase", price: 122 },
  { name: "A MIDI Keyboard", price: 107 },
  { name: "A 4-Person Tent", price: 106 },
  { name: "A Home Brew Kit", price: 114 },
  { name: "A Beginner Telescope", price: 119 },
  { name: "A Refurbished iPad", price: 149 },
];

function pickItem(fillCost) {
  const doy = getDayOfYear(new Date());
  let pool = ITEMS.filter(i => Math.abs(i.price - fillCost) <= 10);
  if (pool.length < 3) pool = ITEMS;
  const idx = Math.floor(seeded(doy * 7 + 3) * pool.length);
  return pool[idx];
}

// ── Worker ──

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const debug = url.searchParams.has('debug');

    try {
      const priceCents = await fetchLivePrice();
      const fillCost = (priceCents / 100) * 50;
      const whole = Math.floor(fillCost);
      const cents = Math.round((fillCost - whole) * 100).toString().padStart(2, '0');
      const item = pickItem(fillCost);

      if (debug) {
        return new Response(JSON.stringify({ priceCents, fillCost, whole, cents, item }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const html = '<div style="display:flex;flex-direction:column;width:1200px;height:630px;background-color:#08080a;color:#eee9df;font-family:Arial;padding:50px 60px"><div style="display:flex;font-size:20px;color:#999589;letter-spacing:2px;margin-bottom:24px">FUEL REALITY CHECK</div><div style="display:flex;font-size:130px;font-weight:900;color:#FFD600;line-height:1">$' + whole + '.' + cents + '</div><div style="display:flex;font-size:24px;color:#999589;margin-top:12px;margin-bottom:36px">to fill a Toyota Camry (50L) today</div><div style="display:flex;flex-direction:column;background-color:#1a1a1a;padding:28px 32px;border-radius:4px"><div style="display:flex;font-size:16px;color:#FF6B00;letter-spacing:3px;margin-bottom:10px">INSTEAD YOU COULD BUY</div><div style="display:flex;font-size:46px;font-weight:900;color:#eee9df">' + item.name + '</div></div></div>';

      return new ImageResponse(html, {
        width: 1200,
        height: 630,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
