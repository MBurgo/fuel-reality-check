# Fuel Reality Check

A viral one-page site that shows what you could buy instead of filling up your car — updated daily with real fuel prices.

## Architecture

```
[AIP public pages (free, no signup)] → [Cloudflare Worker (scrapes + caches)] → [Static Site]
```

**Total cost: ~$15/year** (just the domain). Everything else is free.

## How Daily Pricing Works

No API keys. No signups. No waiting for approval. The worker scrapes two public AIP pages and combines them for a calibrated daily estimate:

1. **AIP Terminal Gate Prices** (`api.aip.com.au/public/tgpTables`) — Brisbane wholesale ULP, updated every weekday morning. This provides the daily movement.

2. **AIP QLD Retail Prices** (`api.aip.com.au/public/qldUlpTable`) — Brisbane average pump price, updated weekly. This anchors the wholesale number to what people actually pay.

3. **Calibration**: The worker calculates the offset between the weekly retail price and the wholesale price from the same period, then applies that offset to today's wholesale price. This gives a retail estimate that moves daily with the market.

Example with real data (23 March 2026):
- Retail (week ending 15 Mar): 221.3 c/L
- TGP (17 Mar, start of table): 224.5 c/L → offset = -3.2 c/L
- TGP (23 Mar, today): 242.7 c/L
- **Estimated retail today: 242.7 + (-3.2) ≈ 239.5 c/L**
- **Fill-up cost: ~$119.75**

On weekends the most recent Friday TGP is used. The cache refreshes every 4 hours.

## Setup

### 1. Deploy the Cloudflare Worker (5 minutes)

```bash
npm install -g wrangler
wrangler login
mkdir fuel-worker && cd fuel-worker
wrangler init
# Copy worker.js → src/index.js
wrangler deploy
```

No secrets. Note your worker URL.

### 2. Deploy the Frontend

1. Open `index.html`
2. Set `WORKER_URL` to your Cloudflare Worker URL
3. Push to Cloudflare Pages / Netlify / Vercel

### 3. Domain

Register something like `fuelrealitycheck.com.au` and point it at your host.

## Customisation

### Items Database
115+ curated items across: food, entertainment, hobbies, pets, home, wellness, fashion, kids, experiences, tech, absurd, charitable. Ranges from $85–$125 to match typical fill-up costs. Add more for variety.

### Change the Car
Update `TANK_LITRES` and car name. Camry 50L, Corolla 50L, Ranger 80L, HiLux 80L.

### Without the Worker (MVP)
Leave `WORKER_URL` empty. The site works with simulated prices and shows "Estimated" badge. Update `FALLBACK_PRICE_CENTS` occasionally.

## Source Badges

The site shows a badge indicating data freshness:
- **Daily price** — TGP + retail calibration (best case)
- **Daily estimate** — TGP only, default offset
- **Weekly avg** — retail only, no TGP available
- **Estimated** — fallback/simulated

## Future Upgrade: QLD Government API

For per-station real-time pricing, sign up at [fuelpricesqld.com.au](https://www.fuelpricesqld.com.au) as a data consumer (free, but requires manual verification call). When approved, swap the AIP scraper for the QLD API.

## Costs

| Component | Cost |
|-----------|------|
| AIP data | Free (public pages) |
| Cloudflare Worker | Free (100k req/day) |
| Cloudflare Pages | Free |
| Domain (.com.au) | ~$15/year |
| **Total** | **~$15/year** |

## License

Do whatever you want with it.
