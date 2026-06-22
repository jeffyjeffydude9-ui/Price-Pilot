# Deploy PricePilot to Render + connect eBay

You need a **public URL** for two reasons: to share the site, and because eBay
will not redirect to `localhost` during login. Render gives you that URL.

## Step 1 — Put the code on GitHub
1. Create a new repo on github.com (e.g. `pricepilot`).
2. Push this folder to it. (`secrets.json` is git-ignored, so your keys stay private —
   you'll add them to Render as environment variables instead.)

## Step 2 — Deploy on Render
1. render.com → **New → Web Service** → connect your GitHub repo.
2. Render detects `render.yaml`. If asked, set:
   - **Runtime:** Python
   - **Build command:** *(leave empty)*
   - **Start command:** `python server/app.py`
3. Open the **Environment** tab and add:
   - `SEARCH_API_KEY` = your SerpAPI key (the Google Shopping one you already have)
4. **Create Web Service.** After it builds you get a public URL like
   `https://pricepilot-xxxx.onrender.com`. The search + prices work now.

## Step 3 — Make eBay API keys (free, no card)
1. Go to **developer.ebay.com** → sign in / register → **Join eBay Developers Program**.
2. **Application Keys** → create a **Production** keyset. Copy:
   - **App ID (Client ID)**
   - **Cert ID (Client Secret)**
3. **User Tokens → Get a Token from eBay via Your Application →** under *Your eBay
   Sign-in Settings* click **Add eBay Redirect URL** and set:
   - **Auth accepted URL:** `https://pricepilot-xxxx.onrender.com/api/ebay/callback`
   - **Auth declined URL:**  `https://pricepilot-xxxx.onrender.com/?ebay=error`
   - eBay generates a **RuName** string — copy it.

## Step 4 — Add the eBay keys to Render
In Render → Environment, add and then redeploy:
- `EBAY_CLIENT_ID`     = App ID
- `EBAY_CLIENT_SECRET` = Cert ID
- `EBAY_RUNAME`        = the RuName string

## Step 5 — Connect your store
Open your Render URL → **Repricing** → **Connect eBay account** → approve once.
Your listings load; click **Analyze**, then **Apply to eBay** to push a new price.
(You approve only once — the token is stored and auto-refreshed.)

---
### Notes
- The free SerpAPI key = 100 searches/month shared across all visitors. Upgrade if you
  go live to real traffic.
- Render free tier sleeps after inactivity; the first request after a nap is slow.
- Locally you can keep keys in `server/secrets.json` instead of env vars.
