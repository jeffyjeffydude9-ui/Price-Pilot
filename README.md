# PricePilot

> Price every product like a pro. Search any item — by name, details, or a listing
> URL — and PricePilot analyzes the item's specs, scans the web for comparable
> listings across platforms, and tells sellers if their price is **too high to sell**
> or **too low to profit**. Then they can subscribe to the service in a couple clicks.

Three parts:

1. **`website/`** — interactive marketing site with a **search-first live demo**.
2. **`server/`** — a dependency-free Python backend: web price search + **real Stripe
   Checkout**.
3. **`extension/`** — a Manifest V3 browser extension that analyzes any product page.

---

## Quick start

No pip installs, no Node — just Python 3.

```bash
cd pricepilot
python3 server/app.py
# → open http://localhost:8123
```

That's it. The search bar works immediately (smart demo data) and the buy flow runs
in safe demo mode until you add a Stripe key.

### Enable real Stripe checkout
```bash
export STRIPE_SECRET_KEY=sk_test_...        # from dashboard.stripe.com (test mode is fine)
python3 server/app.py
```
Clicking a paid plan now creates a real **Stripe Checkout Session** (subscription, with
a 14-day trial and promo codes enabled) and redirects to Stripe's hosted page. On
return, the site shows a success/cancel toast. Use Stripe's test card `4242 4242 4242 4242`.

> The backend calls the Stripe REST API directly over HTTPS — no `stripe` SDK needed.

### Enable ACCURATE live prices (recommended — free, no credit card)
Use eBay's official **Browse API** for real, current listing prices:
1. Sign up at **https://developer.ebay.com** (free).
2. Create an app keyset → copy your **App ID (Client ID)** and **Cert ID (Client Secret)**.
3. Run with:
   ```bash
   export EBAY_CLIENT_ID=YourApp-...
   export EBAY_CLIENT_SECRET=PRD-...
   python3 server/app.py
   ```
The badge flips to **"Live eBay prices"** and every listing is a real, clickable eBay item.

**Why keys?** Servers can't reliably scrape retail sites — Amazon/eBay/Google block
datacenter IPs (you'll see a 403). The free eBay API is the dependable, ToS-compliant
way to get accurate prices. There's also a best-effort no-key eBay scraper that often
works when you run the server from a home/residential connection; if it's blocked, the
app falls back to clearly-labeled **demo prices** so nothing breaks.

### Connect your eBay store & auto-reprice
PricePilot can link your eBay seller account, read your live listings, suggest the
optimal price for each (benchmarked against the market), and **push the new price back
to eBay** — with a confirm step before any change.

1. In your eBay developer app, add a **redirect URL (RuName)** whose accept-URL points to
   `http://localhost:8123/api/ebay/callback`.
2. Run with your app keys + RuName:
   ```bash
   export EBAY_CLIENT_ID=YourApp-...
   export EBAY_CLIENT_SECRET=PRD-...
   export EBAY_RUNAME=Your-RuName-value
   python3 server/app.py
   ```
3. Open the **Repricing** section on the site → **Connect eBay account** → approve.
4. Your listings load; click **Analyze** on any item, then **Apply to eBay** to push the
   suggested price. Every write requires an explicit confirm — nothing changes silently.

Under the hood: OAuth Authorization-Code flow, `GetMyeBaySelling` to read listings, and
`ReviseInventoryStatus` to update prices (Trading API). Tokens are stored in
`server/.ebay_user.json` and auto-refreshed. The same pattern extends to Shopify/Amazon.

### Or use SerpAPI (paid, multi-retailer Google Shopping)
```bash
export SEARCH_PROVIDER=serpapi
export SEARCH_API_KEY=...                   # serpapi.com key
python3 server/app.py
```
Adding another provider is a ~15-line function in `server/app.py` (`search_<provider>`).

---

## How it works

### Search & analysis (`POST /api/search`)
1. **Detail analysis** — `analyze_details()` reads the query (or URL slug) and extracts
   brand, category, condition, color, and specs (GB / inch / ml / mAh / pack…).
2. **Web search** — fetches comparable listings (live provider or generator).
3. **Scoring** — the frontend positions your price on a **0–100 score** between the
   cheapest comp and the highest the market bears, computes your **% vs. median** and
   **margin**, and recommends a price that targets the median **without dropping below a
   healthy 25% margin** over your cost (charm-priced at `.99`).

### Checkout (`POST /api/checkout`)
Creates a Stripe subscription Checkout Session from inline `price_data` (no pre-created
Prices needed). Falls back to a clearly-labeled demo response when no key is set.

## The browser extension
Manifest V3 — `chrome://extensions` → Developer mode → **Load unpacked** → pick
`extension/`. It detects the price on any product page (site selectors → JSON-LD →
meta → on-page text) and shows the same verdict, gauge, and margin-safe suggestion.

## Project structure
```
pricepilot/
├── server/
│   └── app.py          # stdlib backend: static + /api/search + /api/checkout + /api/config
├── website/
│   ├── index.html      # landing + search-first interactive demo
│   ├── styles.css      # design system (blue + amber, Fira Sans/Code)
│   └── app.js          # search, scoring, gauge/charts, Stripe checkout, toasts
├── extension/          # MV3 extension (manifest, content/background/popup, icons)
└── README.md
```

## Environment variables
| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | server port | `8123` |
| `STRIPE_SECRET_KEY` | enables real checkout | _(demo mode)_ |
| `EBAY_CLIENT_ID` | eBay App ID → live prices **+ account connect** | _(none)_ |
| `EBAY_CLIENT_SECRET` | eBay Cert ID | _(none)_ |
| `EBAY_RUNAME` | eBay RuName → enables connecting a seller account & repricing | _(none)_ |
| `WALMART_CLIENT_ID` | Walmart Marketplace API key → read items & reprice | _(none)_ |
| `WALMART_CLIENT_SECRET` | Walmart Marketplace API secret | _(none)_ |
| `SEARCH_PROVIDER` | `auto`, `ebay`, `serpapi`, or `mock` | `auto` |
| `SEARCH_API_KEY` | key for SerpAPI (if used) | _(none)_ |
