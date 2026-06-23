#!/usr/bin/env python3
"""
PricePilot backend — pure Python stdlib (no pip deps).

Responsibilities
  1. Serve the static marketing site (../website).
  2. POST /api/search   -> analyze an item's details + fetch comparable
                           prices from the web (pluggable provider, with a
                           realistic built-in generator fallback).
  3. POST /api/checkout -> create a REAL Stripe Checkout Session via the
                           Stripe REST API and return its hosted URL.
  4. GET  /api/config   -> tells the frontend what's configured.

Environment variables
  STRIPE_SECRET_KEY   sk_test_... or sk_live_...   (enables real checkout)
  SEARCH_PROVIDER     "serpapi" | "mock" (default "mock")
  SEARCH_API_KEY      key for the chosen search provider
  PORT                default 8123
"""

import os
import re
import json
import html
import time
import uuid
import base64
import hashlib
import secrets
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEBSITE_DIR = os.path.normpath(os.path.join(ROOT, "..", "website"))
PORT = int(os.environ.get("PORT", "8123"))

# Persistent data location. On Render, attach a disk and set DATA_DIR to its
# mount path (e.g. /var/data) so accounts survive restarts/redeploys.
DATA_DIR = (os.environ.get("DATA_DIR", "").strip() or ROOT)
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = ROOT

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
SEARCH_PROVIDER = os.environ.get("SEARCH_PROVIDER", "auto").strip().lower()
SEARCH_API_KEY = os.environ.get("SEARCH_API_KEY", "").strip()
# Free, accurate, ToS-compliant prices: register an app at developer.ebay.com
# (no credit card) and set these two. This is the recommended live source.
EBAY_CLIENT_ID = os.environ.get("EBAY_CLIENT_ID", "").strip()
EBAY_CLIENT_SECRET = os.environ.get("EBAY_CLIENT_SECRET", "").strip()
# RuName (eBay redirect/"redirect_uri" value) from your eBay app — required to
# connect a user account and write prices back.
EBAY_RUNAME = os.environ.get("EBAY_RUNAME", "").strip()
EBAY_ENV = os.environ.get("EBAY_ENV", "production").strip().lower()
_ebay_token = {"value": "", "exp": 0}          # app token (read-only Browse search)


def _ebay_api():
    return "https://api.sandbox.ebay.com" if EBAY_ENV == "sandbox" else "https://api.ebay.com"


def _ebay_auth():
    return "https://auth.sandbox.ebay.com" if EBAY_ENV == "sandbox" else "https://auth.ebay.com"

# Walmart Marketplace — client-credentials keys (no browser approval needed).
# Get them at: Walmart Seller Center → Settings → API Key Management.
WALMART_CLIENT_ID = os.environ.get("WALMART_CLIENT_ID", "").strip()
WALMART_CLIENT_SECRET = os.environ.get("WALMART_CLIENT_SECRET", "").strip()
_walmart_token = {"value": "", "exp": 0}

# OAuth scopes needed to read a user's listings and revise prices.
EBAY_USER_SCOPES = "https://api.ebay.com/oauth/api_scope/sell.inventory"
EBAY_USER_TOKEN_FILE = os.path.join(DATA_DIR, ".ebay_user.json")
_ebay_user = {}   # {access_token, refresh_token, exp}


def _load_ebay_user():
    global _ebay_user
    try:
        with open(EBAY_USER_TOKEN_FILE) as f:
            _ebay_user = json.load(f)
    except Exception:
        _ebay_user = {}


def _save_ebay_user():
    try:
        with open(EBAY_USER_TOKEN_FILE, "w") as f:
            json.dump(_ebay_user, f)
    except Exception as e:
        print("[ebay] could not persist token:", e)


def _load_secrets():
    """Bake in keys from server/secrets.json so the app works automatically with
    zero user input. Env vars still win if set. Kept server-side only — never
    sent to the browser."""
    global SEARCH_API_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME, STRIPE_SECRET_KEY
    global WALMART_CLIENT_ID, WALMART_CLIENT_SECRET, PAYPAL_CLIENT_ID, PAYPAL_SECRET
    global EBAY_ENV, PAYPAL_ENV, PAYPAL_BASE, PAYPAL_PLAN_ID
    try:
        with open(os.path.join(ROOT, "secrets.json")) as f:
            s = json.load(f)
    except Exception:
        return
    SEARCH_API_KEY = SEARCH_API_KEY or (s.get("serpApiKey") or "").strip()
    EBAY_CLIENT_ID = EBAY_CLIENT_ID or (s.get("ebayClientId") or "").strip()
    EBAY_CLIENT_SECRET = EBAY_CLIENT_SECRET or (s.get("ebayClientSecret") or "").strip()
    EBAY_RUNAME = EBAY_RUNAME or (s.get("ebayRuName") or "").strip()
    if s.get("ebayEnv"):
        EBAY_ENV = s["ebayEnv"].strip().lower()
    STRIPE_SECRET_KEY = STRIPE_SECRET_KEY or (s.get("stripeSecretKey") or "").strip()
    WALMART_CLIENT_ID = WALMART_CLIENT_ID or (s.get("walmartClientId") or "").strip()
    WALMART_CLIENT_SECRET = WALMART_CLIENT_SECRET or (s.get("walmartClientSecret") or "").strip()
    PAYPAL_CLIENT_ID = PAYPAL_CLIENT_ID or (s.get("paypalClientId") or "").strip()
    PAYPAL_SECRET = PAYPAL_SECRET or (s.get("paypalSecret") or "").strip()
    PAYPAL_PLAN_ID = PAYPAL_PLAN_ID or (s.get("paypalPlanId") or "").strip()
    if s.get("paypalEnv"):
        PAYPAL_ENV = s["paypalEnv"].strip().lower()
        PAYPAL_BASE = "https://api-m.sandbox.paypal.com" if PAYPAL_ENV == "sandbox" else "https://api-m.paypal.com"


# Subscription plans (amounts in cents). price_data is created inline so you
# don't need to pre-create Prices in the Stripe dashboard.
PLANS = {
    "growth": {"name": "PricePilot Growth", "amount": 2900, "interval": "month"},
    "scale":  {"name": "PricePilot Scale",  "amount": 9900, "interval": "month"},
}

# Freemium: this many free searches per visitor PER DAY, then a paywall.
FREE_SEARCH_LIMIT = int(os.environ.get("FREE_SEARCH_LIMIT", "2"))
SEARCH_COUNTS = {}   # "ip|YYYY-MM-DD" -> count

# PayPal (for the purchase menu). Client ID is public; secret stays server-side.
PAYPAL_CLIENT_ID = os.environ.get("PAYPAL_CLIENT_ID", "").strip()
PAYPAL_SECRET = os.environ.get("PAYPAL_SECRET", "").strip()
PAYPAL_ENV = os.environ.get("PAYPAL_ENV", "live").strip().lower()   # "live" or "sandbox"
PAYPAL_BASE = "https://api-m.sandbox.paypal.com" if PAYPAL_ENV == "sandbox" else "https://api-m.paypal.com"
PAYPAL_PLAN_ID = os.environ.get("PAYPAL_PLAN_ID", "").strip()       # P-xxxx → enables monthly recurring
PLAN_PRICE = "29.00"

# Accounts: simple file-backed users + in-memory sessions.
BOSS_EMAIL = "jeffyjeffydude9@gmail.com"   # always unlimited, on any server
USERS_FILE = os.path.join(DATA_DIR, "users.json")
_users = {}            # email -> {salt, hash, paid, created}
_sessions = {}         # token -> email


def _load_users():
    global _users
    try:
        with open(USERS_FILE) as f:
            _users = json.load(f)
    except Exception:
        _users = {}


def _save_users():
    try:
        with open(USERS_FILE, "w") as f:
            json.dump(_users, f)
    except Exception as e:
        print("[auth] could not save users:", e)


def _hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 120000).hex()
    return salt, h

PLATFORMS = ["Amazon", "eBay", "Walmart", "Etsy", "Shopify", "Target", "Best Buy", "Mercari"]
SEARCH_URLS = {
    "Amazon":   "https://www.amazon.com/s?k={q}",
    "eBay":     "https://www.ebay.com/sch/i.html?_nkw={q}",
    "Walmart":  "https://www.walmart.com/search?q={q}",
    "Etsy":     "https://www.etsy.com/search?q={q}",
    "Shopify":  "https://www.google.com/search?q={q}+site:myshopify.com",
    "Target":   "https://www.target.com/s?searchTerm={q}",
    "Best Buy": "https://www.bestbuy.com/site/searchpage.jsp?st={q}",
    "Mercari":  "https://www.mercari.com/search/?keyword={q}",
}

CATEGORY_WORDS = {
    "music": ["guitar", "stratocaster", "telecaster", "bass", "synth", "synthesizer", "pedal",
              "amplifier", "amp", "keyboard", "piano", "drum", "microphone", "mixer", "fender",
              "gibson", "korg", "roland", "moog", "ukulele", "violin", "saxophone", "turntable"],
    "media": ["movie", "film", "blu-ray", "bluray", "dvd", "vinyl", "soundtrack", "album",
              "audiobook", "cd ", "boxset", "box set"],
    "electronics": ["headphone", "earbud", "laptop", "phone", "iphone", "camera", "speaker",
                    "monitor", "charger", "tablet", "ipad", "gpu", "rtx", "ssd", "cpu", "ryzen",
                    "geforce", "radeon", "motherboard", "console", "tv", "router", "keyboard"],
    "home": ["kitchen", "furniture", "decor", "bedding", "mat", "cookware", "vacuum", "lamp", "chair", "desk"],
    "fashion": ["shirt", "dress", "shoe", "sneaker", "jacket", "jersey", "apparel", "jeans", "hoodie", "bag"],
    "beauty": ["lipstick", "serum", "skincare", "makeup", "cream", "fragrance", "perfume", "shampoo", "moisturizer"],
    "toys": ["toy", "lego", "puzzle", "doll", "funko", "figure", "boardgame", "nerf", "pokemon", "card"],
}

CONDITION_WORDS = ["new", "used", "refurbished", "renewed", "open box", "pre-owned", "like new"]
COLOR_WORDS = ["black", "white", "silver", "gray", "grey", "blue", "red", "green", "pink",
               "gold", "rose gold", "purple", "beige", "navy"]
UNIT_RE = re.compile(r"\b(\d+(?:\.\d+)?)\s?(gb|tb|mb|mah|inch|in|\"|cm|mm|ml|l|oz|lb|kg|g|w|hz|mp|k|pack|pcs|ct)\b", re.I)


# ----------------------------------------------------------------------------
# Item detail analysis
# ----------------------------------------------------------------------------
def analyze_details(query):
    q = query.strip()
    low = q.lower()

    # If the query is a URL, derive a readable name from it.
    name = q
    if low.startswith("http"):
        path = urllib.parse.urlparse(q).path
        slug = re.split(r"[/?]", path.strip("/"))[-1] if path else ""
        slug = re.sub(r"[-_]+", " ", urllib.parse.unquote(slug))
        slug = re.sub(r"\.(html?|aspx?|php)$", "", slug, flags=re.I)
        name = (slug or urllib.parse.urlparse(q).netloc).strip() or q

    category = "general"
    for cat, words in CATEGORY_WORDS.items():
        if any(w in low for w in words):
            category = cat
            break

    condition = next((c for c in CONDITION_WORDS if c in low), "new")
    color = next((c for c in COLOR_WORDS if c in low), None)

    attributes = []
    brand = None
    tokens = re.findall(r"[A-Za-z0-9.+]+", name)
    if tokens and tokens[0][:1].isalpha():
        brand = tokens[0].capitalize()
        attributes.append({"label": "Brand", "value": brand})
    attributes.append({"label": "Condition", "value": condition.title()})
    if color:
        attributes.append({"label": "Color", "value": color.title()})
    for m in list(UNIT_RE.finditer(low))[:4]:
        attributes.append({"label": "Spec", "value": (m.group(1) + " " + m.group(2)).upper()})

    return {
        "name": name[:90],
        "brand": brand,
        "category": category,
        "condition": condition.title(),
        "attributes": attributes,
        "keywords": re.sub(r"https?://\S+", "", q).strip() or name,
    }


# ----------------------------------------------------------------------------
# Comparable-price search
# ----------------------------------------------------------------------------
def _seeded(seed):
    s = seed % 2147483647 or 1
    def rnd():
        nonlocal s
        s = (s * 16807) % 2147483647
        return s / 2147483647
    return rnd


def search_mock(item):
    """Deterministic, realistic comps so the product works with zero config.
    Links point at each platform's real search results for the query."""
    q = item["keywords"]
    h = int(hashlib.sha256(q.encode("utf-8")).hexdigest(), 16)
    rnd = _seeded(h)
    base = 12 + (h % 30000) / 100.0          # $12 .. ~$312
    base = round(base, 2)
    enc = urllib.parse.quote_plus(q)

    n = 6 + int(rnd() * 3)                    # 6..8 comps
    chosen = PLATFORMS[:n]
    comps = []
    for p in chosen:
        factor = 0.8 + rnd() * 0.5            # 0.80 .. 1.30
        price = round(base * factor, 2)
        cond = item["condition"]
        if rnd() < 0.25:
            cond = "Used"
            price = round(price * 0.82, 2)
        comps.append({
            "platform": p,
            "title": f"{item['name']}",
            "price": price,
            "currency": "USD",
            "condition": cond,
            "url": SEARCH_URLS.get(p, "https://www.google.com/search?q={q}").format(q=enc),
        })
    comps.sort(key=lambda c: c["price"])
    return comps, "mock"


def search_serpapi(item, api_key):
    """Live Google Shopping results via SerpAPI — universal, every category."""
    params = urllib.parse.urlencode({
        "engine": "google_shopping",
        "q": item["keywords"],
        "api_key": api_key,
        "num": "20",
        "gl": "us", "hl": "en",
    })
    url = "https://serpapi.com/search.json?" + params
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    comps = []
    for r in data.get("shopping_results", [])[:12]:
        price = r.get("extracted_price")
        if not price:
            continue
        comps.append({
            "platform": r.get("source", "Web"),
            "title": r.get("title", item["name"])[:120],
            "price": round(float(price), 2),
            "currency": "USD",
            "condition": item["condition"],
            "url": r.get("product_link") or r.get("link") or "#",
        })
    comps.sort(key=lambda c: c["price"])
    return comps, "serpapi"


BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_TAG_RE = re.compile(r"<[^>]+>")
_PRICE_RE = re.compile(r"\$\s?([\d,]+(?:\.\d{2})?)")


def _strip(s):
    return html.unescape(re.sub(r"\s+", " ", _TAG_RE.sub(" ", s)).strip())


def search_ebay(item):
    """REAL live prices by fetching eBay's public search results server-side and
    parsing them. No API key required. Buy-It-Now listings only, USD."""
    q = urllib.parse.quote_plus(item["keywords"])
    url = (f"https://www.ebay.com/sch/i.html?_nkw={q}"
           "&LH_BIN=1&_sop=12&_ipg=60&LH_PrefLoc=1")  # fixed price, best match, US
    req = urllib.request.Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        page = resp.read().decode("utf-8", "ignore")

    comps = []
    seen = set()
    # Each result's content lives in an "s-item__info" block.
    chunks = page.split("s-item__info")
    for chunk in chunks[1:]:
        chunk = chunk[:4000]
        pm = re.search(r's-item__price[^>]*>(.*?)</span>', chunk, re.S)
        if not pm:
            continue
        price_m = _PRICE_RE.search(_strip(pm.group(1)))
        if not price_m:
            continue
        price = float(price_m.group(1).replace(",", ""))
        if price <= 0:
            continue
        tm = re.search(r's-item__title[^>]*>(.*?)</(?:div|h3|span)>', chunk, re.S)
        title = _strip(tm.group(1)) if tm else item["name"]
        title = re.sub(r'^(New Listing|Shop on eBay)\s*', '', title, flags=re.I).strip()
        if not title or title.lower().startswith("shop on ebay"):
            continue
        lm = re.search(r's-item__link"\s+href="([^"]+)"', chunk)
        link = lm.group(1) if lm else url
        cm = re.search(r'SECONDARY_INFO[^>]*>([^<]+)<', chunk)
        cond = _strip(cm.group(1)) if cm else item["condition"]
        key = round(price, 2)
        if key in seen:
            continue
        seen.add(key)
        comps.append({
            "platform": "eBay",
            "title": title[:120],
            "price": round(price, 2),
            "currency": "USD",
            "condition": cond[:24] or "—",
            "url": link,
        })
        if len(comps) >= 12:
            break

    # Drop obvious accessory/outlier noise: keep prices within 5x of the median.
    if len(comps) >= 4:
        ps = sorted(c["price"] for c in comps)
        med = ps[len(ps) // 2]
        comps = [c for c in comps if med / 5 <= c["price"] <= med * 5] or comps

    comps.sort(key=lambda c: c["price"])
    if len(comps) < 3:
        raise ValueError(f"eBay returned too few results ({len(comps)})")
    return comps, "ebay"


def _ebay_access_token():
    """OAuth client-credentials token for the eBay Browse API (cached)."""
    import base64
    if _ebay_token["value"] and _ebay_token["exp"] > time.time() + 30:
        return _ebay_token["value"]
    basic = base64.b64encode(f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "scope": "https://api.ebay.com/oauth/api_scope",
    }).encode()
    req = urllib.request.Request(
        _ebay_api() + "/identity/v1/oauth2/token", data=body,
        headers={"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    _ebay_token["value"] = data["access_token"]
    _ebay_token["exp"] = time.time() + int(data.get("expires_in", 7200))
    return _ebay_token["value"]


def search_ebay_api(item):
    """REAL, accurate prices via eBay's official Browse API (free dev keys)."""
    token = _ebay_access_token()
    # Best-match (not cheapest-first) so the set is representative, then we filter.
    params = urllib.parse.urlencode({
        "q": item["keywords"],
        "limit": "50",
        "filter": "buyingOptions:{FIXED_PRICE}",
    })
    url = _ebay_api() + "/buy/browse/v1/item_summary/search?" + params
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    comps = []
    for it in data.get("itemSummaries", []):
        price = it.get("price", {})
        val = price.get("value")
        if not val or price.get("currency") != "USD":
            continue
        comps.append({
            "platform": "eBay",
            "title": (it.get("title") or item["name"])[:120],
            "price": round(float(val), 2),
            "currency": "USD",
            "condition": it.get("condition", item["condition"])[:24],
            "url": it.get("itemWebUrl", "#"),
        })

    # Drop junk/accessory outliers (e.g. $0.99 single cards under a sealed box):
    # keep prices within 1/4 .. 4x of the median.
    if len(comps) >= 5:
        ps = sorted(c["price"] for c in comps)
        med = ps[len(ps) // 2]
        comps = [c for c in comps if med / 4 <= c["price"] <= med * 4] or comps
    comps.sort(key=lambda c: c["price"])
    comps = comps[:15]
    if len(comps) < 3:
        raise ValueError(f"eBay API returned too few results ({len(comps)})")
    return comps, "ebay"


# ----------------------------------------------------------------------------
# eBay ACCOUNT integration — connect a seller account, read listings, reprice.
# Uses the OAuth Authorization-Code flow + the Trading API.
# ----------------------------------------------------------------------------
def ebay_consent_url():
    """Where to send the user to authorize PricePilot on their eBay account."""
    params = urllib.parse.urlencode({
        "client_id": EBAY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": EBAY_RUNAME,
        "scope": EBAY_USER_SCOPES,
    })
    return _ebay_auth() + "/oauth2/authorize?" + params


def ebay_exchange_code(code):
    """Swap the auth code for user access + refresh tokens."""
    basic = base64.b64encode(f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code", "code": code, "redirect_uri": EBAY_RUNAME,
    }).encode()
    req = urllib.request.Request(
        _ebay_api() + "/identity/v1/oauth2/token", data=body,
        headers={"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    _ebay_user.update({
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token", _ebay_user.get("refresh_token", "")),
        "exp": time.time() + int(data.get("expires_in", 7200)),
    })
    _save_ebay_user()


def ebay_user_token():
    """Valid user access token, refreshing with the refresh_token if expired."""
    if _ebay_user.get("access_token") and _ebay_user.get("exp", 0) > time.time() + 30:
        return _ebay_user["access_token"]
    rt = _ebay_user.get("refresh_token")
    if not rt:
        raise ValueError("eBay account not connected")
    basic = base64.b64encode(f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token", "refresh_token": rt, "scope": EBAY_USER_SCOPES,
    }).encode()
    req = urllib.request.Request(
        _ebay_api() + "/identity/v1/oauth2/token", data=body,
        headers={"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    _ebay_user["access_token"] = data["access_token"]
    _ebay_user["exp"] = time.time() + int(data.get("expires_in", 7200))
    _save_ebay_user()
    return _ebay_user["access_token"]


def _trading_call(call_name, xml_body):
    token = ebay_user_token()
    req = urllib.request.Request(
        _ebay_api() + "/ws/api.dll", data=xml_body.encode("utf-8"),
        headers={
            "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1191",
            "X-EBAY-API-CALL-NAME": call_name,
            "X-EBAY-API-IAF-TOKEN": token,
            "Content-Type": "text/xml",
        }, method="POST")
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode("utf-8", "ignore")


def ebay_my_listings():
    """Active listings on the connected account, with current prices."""
    xml = ('<?xml version="1.0" encoding="utf-8"?>'
           '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
           '<ActiveList><Include>true</Include>'
           '<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>'
           '</ActiveList></GetMyeBaySellingRequest>')
    resp = _trading_call("GetMyeBaySelling", xml)
    items = []
    for block in re.findall(r"<Item>(.*?)</Item>", resp, re.S):
        iid = re.search(r"<ItemID>([^<]+)</ItemID>", block)
        title = re.search(r"<Title>(.*?)</Title>", block, re.S)
        price = re.search(r'<CurrentPrice[^>]*>([\d.]+)</CurrentPrice>', block) \
            or re.search(r'<StartPrice[^>]*>([\d.]+)</StartPrice>', block)
        if not (iid and price):
            continue
        items.append({
            "itemId": iid.group(1),
            "title": html.unescape(re.sub(r"<[^>]+>", "", title.group(1)).strip()) if title else "(untitled)",
            "price": round(float(price.group(1)), 2),
            "url": f"https://www.ebay.com/itm/{iid.group(1)}",
        })
    return items


def ebay_revise_price(item_id, new_price):
    """Update one listing's price via ReviseInventoryStatus. Returns (ok, msg)."""
    xml = ('<?xml version="1.0" encoding="utf-8"?>'
           '<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
           f'<InventoryStatus><ItemID>{item_id}</ItemID>'
           f'<StartPrice>{new_price:.2f}</StartPrice></InventoryStatus>'
           '</ReviseInventoryStatusRequest>')
    resp = _trading_call("ReviseInventoryStatus", xml)
    ack = re.search(r"<Ack>([^<]+)</Ack>", resp)
    if ack and ack.group(1) in ("Success", "Warning"):
        return True, f"Price updated to ${new_price:.2f}"
    err = re.search(r"<LongMessage>([^<]+)</LongMessage>", resp)
    return False, (err.group(1) if err else "eBay rejected the update")


# ----------------------------------------------------------------------------
# Walmart Marketplace — client-credentials (no browser approval). Read items,
# push price changes.
# ----------------------------------------------------------------------------
WALMART_BASE = "https://marketplace.walmartapis.com"


def _walmart_headers(token=None):
    h = {
        "WM_SVC.NAME": "Walmart Marketplace",
        "WM_QOS.CORRELATION_ID": str(uuid.uuid4()),
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if token:
        h["Authorization"] = "Bearer " + token
        h["WM_SEC.ACCESS_TOKEN"] = token
    return h


def walmart_token():
    if _walmart_token["value"] and _walmart_token["exp"] > time.time() + 30:
        return _walmart_token["value"]
    if not (WALMART_CLIENT_ID and WALMART_CLIENT_SECRET):
        raise ValueError("Walmart not configured")
    basic = base64.b64encode(f"{WALMART_CLIENT_ID}:{WALMART_CLIENT_SECRET}".encode()).decode()
    headers = _walmart_headers()
    headers["Authorization"] = "Basic " + basic
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(WALMART_BASE + "/v3/token",
                                 data=b"grant_type=client_credentials",
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    _walmart_token["value"] = data["access_token"]
    _walmart_token["exp"] = time.time() + int(data.get("expires_in", 900))
    return _walmart_token["value"]


def walmart_items():
    token = walmart_token()
    req = urllib.request.Request(WALMART_BASE + "/v3/items?limit=50",
                                 headers=_walmart_headers(token))
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode())
    items = []
    for it in data.get("ItemResponse", []):
        sku = it.get("sku")
        if not sku:
            continue
        price = (it.get("price") or {}).get("amount")
        items.append({
            "itemId": sku,
            "title": it.get("productName") or sku,
            "price": round(float(price), 2) if price else 0.0,
            "url": f"https://www.walmart.com/ip/{it.get('wpid', '')}",
        })
    return items


def walmart_reprice(sku, new_price):
    token = walmart_token()
    body = json.dumps({
        "sku": sku,
        "pricing": [{
            "currentPriceType": "BASE",
            "currentPrice": {"currency": "USD", "amount": round(new_price, 2)},
        }],
    }).encode()
    req = urllib.request.Request(WALMART_BASE + "/v3/price", data=body,
                                 headers=_walmart_headers(token), method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode())
        # Walmart returns ItemPriceResponse with a success flag.
        ipr = data.get("ItemPriceResponse") or data
        if str(ipr).lower().find("success") >= 0 or ipr.get("message", "").lower().find("success") >= 0:
            return True, f"Price updated to ${new_price:.2f}"
        return True, f"Submitted ${new_price:.2f} to Walmart"
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return False, f"Walmart rejected the update: {detail}"


ITUNES_PLATFORM = {
    "song": "iTunes", "album": "iTunes", "music-video": "iTunes",
    "feature-movie": "Apple TV", "tv-episode": "Apple TV",
    "ebook": "Apple Books", "audiobook": "Audiobooks",
    "software": "App Store", "podcast": "Podcasts",
}


def search_itunes(item):
    """REAL, live prices via Apple's iTunes/App Store Search API. No key, and
    reachable from servers (unlike eBay/Amazon which block datacenter IPs).
    Covers digital goods: movies, music, apps, books, audiobooks."""
    params = urllib.parse.urlencode({"term": item["keywords"], "country": "US", "limit": "25"})
    url = "https://itunes.apple.com/search?" + params
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8", "ignore"))

    comps = []
    seen = set()
    for r in data.get("results", []):
        price = r.get("trackPrice")
        if price is None:
            price = r.get("collectionPrice")
        if not price or price <= 0:
            continue
        title = r.get("trackName") or r.get("collectionName") or item["name"]
        url_i = r.get("trackViewUrl") or r.get("collectionViewUrl") or "#"
        kind = (r.get("kind") or r.get("wrapperType") or "").lower()
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        comps.append({
            "platform": ITUNES_PLATFORM.get(kind, "iTunes"),
            "title": title[:120],
            "price": round(float(price), 2),
            "currency": r.get("currency", "USD"),
            "condition": (r.get("primaryGenreName") or "Digital")[:24],
            "url": url_i,
        })
        if len(comps) >= 15:
            break
    comps.sort(key=lambda c: c["price"])
    if len(comps) < 3:
        raise ValueError(f"iTunes returned too few priced results ({len(comps)})")
    return comps, "itunes"


def search_newegg(item):
    """REAL prices for tech/electronics by parsing Newegg's search results
    server-side (reachable without a key)."""
    q = urllib.parse.quote_plus(item["keywords"])
    url = f"https://www.newegg.com/p/pl?d={q}"
    req = urllib.request.Request(url, headers={
        "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        page = resp.read().decode("utf-8", "ignore")

    generic = {"view details", "newegg", "add to cart", "compare",
               "no limits, no rules, no mercy."}
    comps, seen = [], set()
    for c in page.split('class="item-cell"')[1:]:
        c = c[:6000]
        pm = re.search(r'price-current"[^$]*\$<strong>([\d,]+)</strong>(?:<sup>(\.\d{2})</sup>)?', c)
        if not pm:
            continue
        price = float(pm.group(1).replace(",", "")) + (float(pm.group(2)) if pm.group(2) else 0)
        titles = [t for t in re.findall(r'title="([^"]{6,140})"', c)
                  if t.strip().lower() not in generic]
        if not titles or price <= 0:
            continue
        title = html.unescape(re.sub(r'^Add\s+', '', max(titles, key=len)).strip())
        lm = re.search(r'href="(https://www\.newegg\.com/[^"]+)"', c)
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        comps.append({
            "platform": "Newegg", "title": title[:120], "price": round(price, 2),
            "currency": "USD", "condition": "New", "url": lm.group(1) if lm else url,
        })
        if len(comps) >= 15:
            break

    if len(comps) >= 4:
        ps = sorted(c["price"] for c in comps)
        med = ps[len(ps) // 2]
        comps = [c for c in comps if med / 6 <= c["price"] <= med * 6] or comps
    comps.sort(key=lambda c: c["price"])
    if len(comps) < 3:
        raise ValueError(f"Newegg returned too few results ({len(comps)})")
    return comps, "newegg"


def search_reverb(item):
    """REAL prices from Reverb, the musical-instrument marketplace. No key."""
    params = urllib.parse.urlencode({"query": item["keywords"], "per_page": "20"})
    url = "https://api.reverb.com/api/listings?" + params
    req = urllib.request.Request(url, headers={
        "User-Agent": BROWSER_UA, "Accept": "application/hal+json", "Accept-Version": "3.0",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8", "ignore"))
    comps, seen = [], set()
    for l in data.get("listings", []):
        p = l.get("price", {})
        try:
            price = float(p.get("amount"))
        except (TypeError, ValueError):
            continue
        if price <= 0 or p.get("currency") != "USD":
            continue
        title = html.unescape(l.get("title", item["name"]))
        link = (l.get("_links", {}).get("web", {}) or {}).get("href") \
            or (l.get("_links", {}).get("self", {}) or {}).get("href") or "#"
        cond = (l.get("condition", {}) or {}).get("display_name", "Used")
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        comps.append({"platform": "Reverb", "title": title[:120], "price": round(price, 2),
                      "currency": "USD", "condition": cond[:24], "url": link})
        if len(comps) >= 15:
            break
    if len(comps) >= 4:
        ps = sorted(c["price"] for c in comps)
        med = ps[len(ps) // 2]
        comps = [c for c in comps if med / 8 <= c["price"] <= med * 8] or comps
    comps.sort(key=lambda c: c["price"])
    if len(comps) < 3:
        raise ValueError(f"Reverb returned too few results ({len(comps)})")
    return comps, "reverb"


def price_links(item):
    """When we can't fetch numeric prices for this item, return real links to
    check live prices anywhere — works for every category."""
    q = urllib.parse.quote_plus(item["keywords"])
    return [
        {"name": "Google Shopping", "url": f"https://www.google.com/search?tbm=shop&q={q}"},
        {"name": "Amazon", "url": f"https://www.amazon.com/s?k={q}"},
        {"name": "eBay", "url": f"https://www.ebay.com/sch/i.html?_nkw={q}"},
        {"name": "Walmart", "url": f"https://www.walmart.com/search?q={q}"},
        {"name": "Google", "url": f"https://www.google.com/search?q={q}+price"},
    ]


FREE_PROVIDERS = {"newegg": search_newegg, "reverb": search_reverb, "itunes": search_itunes}
# Which free marketplace fits which detected category (in priority order).
CATEGORY_ROUTING = {
    "music": ["reverb", "newegg"],
    "electronics": ["newegg"],
    "toys": ["newegg"],
    "general": ["newegg", "reverb"],
    # media (iTunes is unreliable), beauty, fashion, home → need a connected key
}


def run_search(query, serpapi_key=None):
    item = analyze_details(query)
    provider_used = "mock"
    comps = []

    # 1) Universal: Google Shopping via SerpAPI (key from request or env).
    #    Covers EVERY category — skincare, fashion, collectibles, tech, all of it.
    sk = (serpapi_key or SEARCH_API_KEY or "").strip()
    if not comps and sk:
        try:
            comps, provider_used = search_serpapi(item, sk)
        except Exception as e:
            print("[search] serpapi failed:", e)
            comps = []

    # 2) Official eBay Browse API (free keys) — universal marketplace if set.
    if not comps and EBAY_CLIENT_ID and EBAY_CLIENT_SECRET:
        try:
            comps, provider_used = search_ebay_api(item)
        except Exception as e:
            print("[search] eBay API failed:", e)
            comps = []

    # 3) No-key real marketplaces, routed by the detected category. Each one
    #    self-limits (returns nothing for irrelevant queries), so wrong matches
    #    are dropped rather than shown.
    if not comps and (SEARCH_PROVIDER == "auto" or SEARCH_PROVIDER in FREE_PROVIDERS):
        order = ([SEARCH_PROVIDER] if SEARCH_PROVIDER in FREE_PROVIDERS
                 else CATEGORY_ROUTING.get(item["category"], ["newegg", "reverb"]))
        for name in order:
            try:
                comps, provider_used = FREE_PROVIDERS[name](item)
                if comps:
                    break
            except Exception as e:
                print(f"[search] {name} failed:", e)
                comps = []

    # 4) Best-effort no-key eBay scrape (works from residential IPs).
    if not comps and SEARCH_PROVIDER in ("auto", "ebay"):
        try:
            comps, provider_used = search_ebay(item)
        except Exception as e:
            print("[search] ebay scrape failed:", e)
            comps = []

    # 5) No free marketplace covers this category here → ask to connect a key
    #    (Google Shopping). No fake numbers, no external link dump.
    if not comps:
        return {"ok": True, "mode": "connect", "query": query, "item": item,
                "source": "connect"}

    prices = sorted(c["price"] for c in comps)
    count = len(prices)
    median = prices[count // 2] if count % 2 else round((prices[count // 2 - 1] + prices[count // 2]) / 2, 2)
    stats = {
        "count": count,
        "low": prices[0],
        "high": prices[-1],
        "median": round(median, 2),
        "mean": round(sum(prices) / count, 2),
    }
    return {"ok": True, "mode": "prices", "query": query, "item": item,
            "comps": comps, "stats": stats, "source": provider_used}


# ----------------------------------------------------------------------------
# PayPal (Orders v2 REST API)
# ----------------------------------------------------------------------------
def paypal_token():
    basic = base64.b64encode(f"{PAYPAL_CLIENT_ID}:{PAYPAL_SECRET}".encode()).decode()
    req = urllib.request.Request(
        PAYPAL_BASE + "/v1/oauth2/token", data=b"grant_type=client_credentials",
        headers={"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())["access_token"]


def paypal_create_order():
    token = paypal_token()
    body = json.dumps({
        "intent": "CAPTURE",
        "purchase_units": [{
            "amount": {"currency_code": "USD", "value": PLAN_PRICE},
            "description": "PricePilot Growth subscription",
        }],
    }).encode()
    req = urllib.request.Request(
        PAYPAL_BASE + "/v2/checkout/orders", data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())["id"]


def paypal_capture(order_id):
    token = paypal_token()
    req = urllib.request.Request(
        PAYPAL_BASE + f"/v2/checkout/orders/{order_id}/capture", data=b"{}",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    return data.get("status") == "COMPLETED", data


def paypal_get_subscription(sub_id):
    """Verify a subscription is real & active."""
    token = paypal_token()
    req = urllib.request.Request(
        PAYPAL_BASE + f"/v1/billing/subscriptions/{sub_id}",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def paypal_cancel_subscription(sub_id):
    """Stop future billing on a subscription."""
    token = paypal_token()
    body = json.dumps({"reason": "Customer cancelled in PricePilot"}).encode()
    req = urllib.request.Request(
        PAYPAL_BASE + f"/v1/billing/subscriptions/{sub_id}/cancel", data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status in (200, 204)


# ----------------------------------------------------------------------------
# Stripe Checkout (REST API, no SDK)
# ----------------------------------------------------------------------------
def stripe_create_checkout(plan_key, host_base):
    plan = PLANS.get(plan_key)
    if not plan:
        return {"ok": False, "error": "Unknown plan."}
    if not STRIPE_SECRET_KEY:
        # Honest demo fallback so the flow is viewable without keys.
        return {"ok": True, "demo": True,
                "message": "Stripe is not configured (set STRIPE_SECRET_KEY to enable real checkout).",
                "plan": plan}

    fields = [
        ("mode", "subscription"),
        ("success_url", f"{host_base}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{host_base}/?checkout=cancel"),
        ("line_items[0][quantity]", "1"),
        ("line_items[0][price_data][currency]", "usd"),
        ("line_items[0][price_data][product_data][name]", plan["name"]),
        ("line_items[0][price_data][unit_amount]", str(plan["amount"])),
        ("line_items[0][price_data][recurring][interval]", plan["interval"]),
        ("allow_promotion_codes", "true"),
        ("billing_address_collection", "auto"),
        ("subscription_data[trial_period_days]", "14"),
    ]
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        "https://api.stripe.com/v1/checkout/sessions",
        data=body,
        headers={
            "Authorization": "Bearer " + STRIPE_SECRET_KEY,
            "Content-Type": "application/x-www-form-urlencoded",
            "Stripe-Version": "2024-06-20",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {"ok": True, "url": data["url"], "id": data["id"]}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except Exception:
            pass
        return {"ok": False, "error": f"Stripe error: {detail}"}
    except Exception as e:
        return {"ok": False, "error": f"Could not reach Stripe: {e}"}


# ----------------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        ".json": "application/json", ".webmanifest": "application/manifest+json",
        ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    server_version = "PricePilot/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    # ---- helpers ----
    def _send_json(self, obj, status=200, cookies=None):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        for c in (cookies or []):
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(payload)

    def _get_cookie(self, name):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def _current_user(self):
        tok = self._get_cookie("pp_session")
        email = _sessions.get(tok) if tok else None
        return (email, _users.get(email)) if email else (None, None)

    def _host_base(self):
        host = self.headers.get("Host", "localhost:%d" % PORT)
        return "http://" + host

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    # ---- GET ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/config":
            has_live_key = bool(EBAY_CLIENT_ID and EBAY_CLIENT_SECRET) or (SEARCH_PROVIDER == "serpapi" and bool(SEARCH_API_KEY))
            return self._send_json({
                "stripeConfigured": bool(STRIPE_SECRET_KEY),
                "searchProvider": SEARCH_PROVIDER,
                "liveKeyConfigured": has_live_key,
                # auto/ebay still attempt a best-effort scrape even without keys
                "liveSearch": has_live_key or SEARCH_PROVIDER in ("auto", "ebay"),
                "ebayAppConfigured": bool(EBAY_CLIENT_ID and EBAY_CLIENT_SECRET and EBAY_RUNAME),
                "plans": PLANS,
            })

        # ---- Accounts ----
        if path == "/api/me":
            email, user = self._current_user()
            return self._send_json({"loggedIn": bool(user), "email": email,
                                    "paid": bool(user and user.get("paid")) or (email == BOSS_EMAIL),
                                    "subId": (user or {}).get("subId", "")})

        if path == "/api/paypal/config":
            return self._send_json({"configured": bool(PAYPAL_CLIENT_ID and PAYPAL_SECRET),
                                    "clientId": PAYPAL_CLIENT_ID, "env": PAYPAL_ENV, "price": PLAN_PRICE,
                                    "planId": PAYPAL_PLAN_ID, "recurring": bool(PAYPAL_PLAN_ID)})

        # ---- eBay account integration ----
        if path == "/api/ebay/status":
            return self._send_json({
                "appConfigured": bool(EBAY_CLIENT_ID and EBAY_CLIENT_SECRET and EBAY_RUNAME),
                "connected": bool(_ebay_user.get("refresh_token")),
            })

        if path == "/api/ebay/connect":
            # Redirect back to the site with a friendly message instead of raw JSON.
            location = ebay_consent_url() if (EBAY_CLIENT_ID and EBAY_RUNAME) else "/?ebay=notconfigured"
            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()
            return

        if path == "/api/ebay/callback":
            qs = urllib.parse.parse_qs(parsed.query)
            code = (qs.get("code") or [""])[0]
            dest = "/?ebay=connected"
            if not code:
                dest = "/?ebay=error"
            else:
                try:
                    ebay_exchange_code(code)
                except Exception as e:
                    print("[ebay] code exchange failed:", e)
                    dest = "/?ebay=error"
            self.send_response(302)
            self.send_header("Location", dest)
            self.end_headers()
            return

        if path == "/api/ebay/listings":
            if not _ebay_user.get("refresh_token"):
                return self._send_json({"ok": False, "error": "eBay account not connected"}, 401)
            try:
                return self._send_json({"ok": True, "listings": ebay_my_listings()})
            except Exception as e:
                return self._send_json({"ok": False, "error": f"Could not load listings: {e}"}, 502)

        # ---- Walmart Marketplace ----
        if path == "/api/walmart/status":
            return self._send_json({
                "appConfigured": bool(WALMART_CLIENT_ID and WALMART_CLIENT_SECRET),
                "connected": bool(WALMART_CLIENT_ID and WALMART_CLIENT_SECRET),
            })

        if path == "/api/walmart/listings":
            if not (WALMART_CLIENT_ID and WALMART_CLIENT_SECRET):
                return self._send_json({"ok": False, "error": "Walmart not connected"}, 401)
            try:
                return self._send_json({"ok": True, "listings": walmart_items()})
            except Exception as e:
                return self._send_json({"ok": False, "error": f"Could not load items: {e}"}, 502)

        # Static files (default to index.html)
        rel = path.lstrip("/") or "index.html"
        if path == "/success":
            rel = "success.html"
        if rel.endswith("/"):
            rel += "index.html"
        file_path = os.path.normpath(os.path.join(WEBSITE_DIR, rel))
        if not file_path.startswith(WEBSITE_DIR):
            return self._send_json({"error": "forbidden"}, 403)
        if not os.path.isfile(file_path):
            # A real file (has an extension) that's missing → 404, don't serve HTML.
            if "." in os.path.basename(rel):
                return self._send_json({"error": "not found"}, 404)
            file_path = os.path.join(WEBSITE_DIR, "index.html")  # SPA route fallback
        try:
            with open(file_path, "rb") as f:
                data = f.read()
        except OSError:
            return self._send_json({"error": "not found"}, 404)
        ext = os.path.splitext(file_path)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.end_headers()
        self.wfile.write(data)

    # ---- POST ----
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/search":
            body = self._read_json()
            query = (body.get("query") or "").strip()
            if not query:
                return self._send_json({"ok": False, "error": "Enter a product name, URL, or details."}, 400)

            # Freemium gate — paid accounts are unlimited; else count per visitor IP.
            email_, user = self._current_user()
            paid = bool(user and user.get("paid")) or (email_ == BOSS_EMAIL) or bool(body.get("paid"))
            is_auto = bool(body.get("auto"))   # the on-load demo search doesn't count
            remaining = None
            if not paid and not is_auto:
                ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                      or self.client_address[0])
                key = ip + "|" + time.strftime("%Y-%m-%d")   # resets each day
                used = SEARCH_COUNTS.get(key, 0)
                if used >= FREE_SEARCH_LIMIT:
                    return self._send_json({"ok": True, "mode": "paywall",
                                            "used": used, "limit": FREE_SEARCH_LIMIT, "perDay": True})
                SEARCH_COUNTS[key] = used + 1
                remaining = FREE_SEARCH_LIMIT - SEARCH_COUNTS[key]

            t0 = time.time()
            result = run_search(query, serpapi_key=(body.get("serpApiKey") or "").strip())
            result["ms"] = int((time.time() - t0) * 1000)
            if remaining is not None:
                result["freeRemaining"] = remaining
            return self._send_json(result)

        if path == "/api/checkout":
            body = self._read_json()
            plan = (body.get("plan") or "growth").strip().lower()
            return self._send_json(stripe_create_checkout(plan, self._host_base()))

        # ---- Accounts ----
        if path in ("/api/signup", "/api/login"):
            body = self._read_json()
            email = (body.get("email") or "").strip().lower()
            pw = body.get("password") or ""
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email) or len(pw) < 6:
                return self._send_json({"ok": False, "error": "Enter a valid email and a 6+ character password."}, 400)
            if path == "/api/signup":
                if email in _users:
                    return self._send_json({"ok": False, "error": "An account with that email already exists."}, 409)
                salt, h = _hash_pw(pw)
                _users[email] = {"salt": salt, "hash": h, "paid": False, "created": time.time()}
                _save_users()
            else:
                u = _users.get(email)
                if not u or _hash_pw(pw, u["salt"])[1] != u["hash"]:
                    return self._send_json({"ok": False, "error": "Wrong email or password."}, 401)
            if email == BOSS_EMAIL and not _users[email].get("paid"):
                _users[email]["paid"] = True
                _save_users()
            token = secrets.token_urlsafe(24)
            _sessions[token] = email
            cookie = f"pp_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
            return self._send_json({"ok": True, "email": email,
                                    "paid": bool(_users[email].get("paid")) or (email == BOSS_EMAIL)},
                                   cookies=[cookie])

        if path == "/api/logout":
            tok = self._get_cookie("pp_session")
            if tok:
                _sessions.pop(tok, None)
            return self._send_json({"ok": True}, cookies=["pp_session=; Path=/; Max-Age=0"])

        # ---- PayPal ----
        if path == "/api/paypal/create-order":
            if not (PAYPAL_CLIENT_ID and PAYPAL_SECRET):
                return self._send_json({"ok": False, "error": "PayPal not configured"}, 400)
            try:
                return self._send_json({"ok": True, "id": paypal_create_order()})
            except Exception as e:
                return self._send_json({"ok": False, "error": f"PayPal error: {e}"}, 502)

        if path == "/api/paypal/capture":
            body = self._read_json()
            order_id = (body.get("orderId") or "").strip()
            if not order_id:
                return self._send_json({"ok": False, "error": "Missing order id"}, 400)
            try:
                ok, _ = paypal_capture(order_id)
            except Exception as e:
                return self._send_json({"ok": False, "error": f"PayPal capture failed: {e}"}, 502)
            if ok:
                email, user = self._current_user()
                if user:                       # unlock the logged-in account
                    user["paid"] = True
                    _save_users()
            return self._send_json({"ok": ok})

        if path == "/api/paypal/subscribe":
            body = self._read_json()
            sub_id = (body.get("subscriptionID") or "").strip()
            if not sub_id:
                return self._send_json({"ok": False, "error": "Missing subscription id"}, 400)
            try:
                sub = paypal_get_subscription(sub_id)
            except Exception as e:
                return self._send_json({"ok": False, "error": f"Could not verify: {e}"}, 502)
            if sub.get("status") in ("ACTIVE", "APPROVED"):
                email, user = self._current_user()
                if user:
                    user["paid"] = True
                    user["subId"] = sub_id
                    _save_users()
                return self._send_json({"ok": True})
            return self._send_json({"ok": False, "error": f"Subscription not active ({sub.get('status')})"}, 400)

        if path == "/api/paypal/cancel":
            email, user = self._current_user()
            if not user:
                return self._send_json({"ok": False, "error": "Not logged in"}, 401)
            sub_id = user.get("subId")
            if sub_id:
                try:
                    paypal_cancel_subscription(sub_id)
                except Exception as e:
                    print("[paypal] cancel failed:", e)
            user["paid"] = False
            user["subId"] = ""
            _save_users()
            return self._send_json({"ok": True})

        if path == "/api/ebay/reprice":
            body = self._read_json()
            item_id = str(body.get("itemId") or "").strip()
            try:
                new_price = round(float(body.get("price")), 2)
            except (TypeError, ValueError):
                return self._send_json({"ok": False, "error": "Invalid price"}, 400)
            if not item_id or new_price <= 0:
                return self._send_json({"ok": False, "error": "Missing item or price"}, 400)
            if not _ebay_user.get("refresh_token"):
                return self._send_json({"ok": False, "error": "eBay account not connected"}, 401)
            # Safeguard: only write when the client explicitly confirms.
            if not body.get("confirm"):
                return self._send_json({"ok": True, "preview": True, "itemId": item_id,
                                        "price": new_price,
                                        "message": f"Will set item {item_id} to ${new_price:.2f}. Send confirm:true to apply."})
            try:
                ok, msg = ebay_revise_price(item_id, new_price)
                return self._send_json({"ok": ok, "itemId": item_id, "price": new_price, "message": msg})
            except Exception as e:
                return self._send_json({"ok": False, "error": f"Reprice failed: {e}"}, 502)

        if path == "/api/walmart/reprice":
            body = self._read_json()
            sku = str(body.get("itemId") or "").strip()
            try:
                new_price = round(float(body.get("price")), 2)
            except (TypeError, ValueError):
                return self._send_json({"ok": False, "error": "Invalid price"}, 400)
            if not sku or new_price <= 0:
                return self._send_json({"ok": False, "error": "Missing item or price"}, 400)
            if not (WALMART_CLIENT_ID and WALMART_CLIENT_SECRET):
                return self._send_json({"ok": False, "error": "Walmart not connected"}, 401)
            if not body.get("confirm"):
                return self._send_json({"ok": True, "preview": True, "itemId": sku, "price": new_price,
                                        "message": f"Will set SKU {sku} to ${new_price:.2f}. Send confirm:true to apply."})
            try:
                ok, msg = walmart_reprice(sku, new_price)
                return self._send_json({"ok": ok, "itemId": sku, "price": new_price, "message": msg})
            except Exception as e:
                return self._send_json({"ok": False, "error": f"Reprice failed: {e}"}, 502)

        return self._send_json({"error": "not found"}, 404)


def main():
    _load_secrets()
    _load_ebay_user()
    _load_users()
    os.chdir(WEBSITE_DIR)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"PricePilot running on http://localhost:{PORT}")
    print(f"  static dir   : {WEBSITE_DIR}")
    print(f"  Stripe       : {'configured' if STRIPE_SECRET_KEY else 'DEMO (set STRIPE_SECRET_KEY)'}")
    print(f"  eBay account : {'connected' if _ebay_user.get('refresh_token') else ('app ready' if (EBAY_CLIENT_ID and EBAY_RUNAME) else 'not configured')}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
