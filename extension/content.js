/* ============================================================
   PricePilot content script
   Detects the product name + price on the current page using a
   layered strategy: site-specific selectors → schema.org JSON-LD
   → meta tags → prominent on-page currency text.
   ============================================================ */

(function () {
  if (window.__pricePilotInjected) return;
  window.__pricePilotInjected = true;

  function parsePrice(str) {
    if (!str) return null;
    // Grab the first currency-looking number, handle 1,299.00 / 1.299,00
    const m = String(str).replace(/\s/g, '').match(/(\d[\d.,]*\d|\d)/);
    if (!m) return null;
    let n = m[1];
    if (n.includes(',') && n.includes('.')) {
      n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
    } else if (n.includes(',')) {
      // treat comma as thousands unless it looks like decimals (1,99)
      n = /,\d{2}$/.test(n) ? n.replace(',', '.') : n.replace(/,/g, '');
    }
    const val = parseFloat(n);
    return isFinite(val) && val > 0 ? val : null;
  }

  function fromSelectors() {
    const SELECTORS = [
      '#corePrice_feature_div .a-offscreen', '.a-price .a-offscreen',          // Amazon
      '.x-price-primary span', '.x-bin-price__content span',                    // eBay
      'p[data-buy-box-region="price"] .currency-value', '.wt-text-title-larger',// Etsy
      '.price__current', '.product__price', '[data-product-price]', '.price-item--regular', // Shopify
      '[itemprop="price"]', '.price', '.product-price', '.current-price'
    ];
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const p = parsePrice(el.getAttribute('content') || el.textContent);
        if (p) return p;
      }
    }
    return null;
  }

  function fromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        let data = JSON.parse(s.textContent);
        const arr = Array.isArray(data) ? data : [data];
        for (let node of arr) {
          const graph = node['@graph'] ? node['@graph'] : [node];
          for (const g of graph) {
            const offers = g.offers && (Array.isArray(g.offers) ? g.offers[0] : g.offers);
            const price = offers && (offers.price || offers.lowPrice);
            if (price) return { price: parseFloat(price), name: g.name };
          }
        }
      } catch (e) { /* ignore malformed */ }
    }
    return null;
  }

  function fromMeta() {
    const sels = ['meta[property="product:price:amount"]', 'meta[property="og:price:amount"]', 'meta[itemprop="price"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) { const p = parsePrice(el.content); if (p) return p; }
    }
    return null;
  }

  function fromVisibleText() {
    // Find the largest visible element that looks like a price.
    const candidates = [];
    const re = /(?:\$|USD|£|€)\s?\d[\d.,]*\d/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node, scanned = 0;
    while ((node = walker.nextNode()) && scanned < 4000) {
      scanned++;
      if (node.children.length > 0) continue;
      const txt = node.textContent.trim();
      if (txt.length > 25 || !re.test(txt)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = parseFloat(getComputedStyle(node).fontSize) || 0;
      const p = parsePrice(txt);
      if (p) candidates.push({ price: p, score: size + (rect.top < 700 ? 20 : 0) });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].price : null;
  }

  function detectName() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.trim().slice(0, 80);
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim().slice(0, 80);
    return document.title.replace(/\s*[|\-–].*$/, '').trim().slice(0, 80) || 'This product';
  }

  function guessCategory() {
    const text = (document.title + ' ' + (document.querySelector('meta[name="keywords"]')?.content || '')).toLowerCase();
    const map = {
      electronics: ['headphone', 'laptop', 'phone', 'camera', 'speaker', 'monitor', 'electronic', 'charger', 'tablet'],
      home: ['kitchen', 'furniture', 'home', 'decor', 'bedding', 'mat', 'cookware'],
      fashion: ['shirt', 'dress', 'shoe', 'sneaker', 'jacket', 'apparel', 'clothing', 'jeans'],
      beauty: ['lipstick', 'serum', 'skincare', 'makeup', 'beauty', 'cream', 'fragrance'],
      toys: ['toy', 'game', 'lego', 'puzzle', 'doll', 'figure'],
    };
    for (const [cat, words] of Object.entries(map)) {
      if (words.some(w => text.includes(w))) return cat;
    }
    return 'electronics';
  }

  function detect() {
    let name = detectName();
    const ld = fromJsonLd();
    let price = fromSelectors() || (ld && ld.price) || fromMeta() || fromVisibleText();
    if (ld && ld.name) name = ld.name.slice(0, 80);
    return {
      ok: !!price,
      price: price || null,
      name,
      category: guessCategory(),
      url: location.href,
      host: location.hostname.replace(/^www\./, ''),
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PP_DETECT') {
      sendResponse(detect());
    }
    return true;
  });
})();
