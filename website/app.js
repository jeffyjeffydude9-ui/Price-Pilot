/* ============================================================
   PricePilot — frontend
   Talks to the Python backend:
     POST /api/search   — analyze item details + fetch web comps
     POST /api/checkout — create a real Stripe Checkout session
     GET  /api/config   — feature flags
   ============================================================ */

const $ = (id) => document.getElementById(id);
const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- Theme toggle ---------- */
const root = document.documentElement;
const savedTheme = localStorage.getItem('pp-theme');
if (savedTheme) root.setAttribute('data-theme', savedTheme);
else if (window.matchMedia('(prefers-color-scheme: dark)').matches) root.setAttribute('data-theme', 'dark');
$('themeToggle').addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  localStorage.setItem('pp-theme', next);
});

/* ---------- Nav scroll shadow ---------- */
const nav = $('nav');
const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

/* ============================================================
   SCORING MODEL — driven by the live market stats from search
   ============================================================ */
function analyzeMarket({ price, cost, stats, comps }) {
  const median = stats.median;
  const deltaPct = median > 0 ? ((price - median) / median) * 100 : 0;
  // Score is driven by how far you sit from the market median so the gauge and
  // the verdict always agree: 50 = at median, <35 = too low, >65 = too high.
  const clamped = Math.max(-25, Math.min(25, deltaPct));
  const pos = Math.max(0, Math.min(100, 50 + (clamped / 25) * 50));
  const margin = price > 0 ? ((price - cost) / price) * 100 : 0;

  const marginFloorPrice = cost > 0 ? cost / 0.75 : 0; // keep >=25% margin
  let suggested = Math.max(median, marginFloorPrice);
  suggested = Math.floor(suggested) + 0.99;
  const suggestedMargin = suggested > 0 ? ((suggested - cost) / suggested) * 100 : 0;

  const cheaper = comps.filter(c => c.price < price).length;
  let verdict, badge, badgeClass, headline, detail;
  if (deltaPct > 7) {
    verdict = 'high'; badge = 'Too high'; badgeClass = 'is-high';
    headline = `Priced ${deltaPct.toFixed(0)}% above the market`;
    detail = `${cheaper} of ${comps.length} comparable listings are cheaper than you. Lowering toward the median should lift conversion and sell-through.`;
  } else if (deltaPct < -7) {
    verdict = 'low'; badge = 'Too low'; badgeClass = 'is-low';
    headline = `Priced ${Math.abs(deltaPct).toFixed(0)}% below the market`;
    detail = `Only ${cheaper} of ${comps.length} listings are cheaper — you're under-pricing. Raising toward the median captures margin without hurting demand.`;
  } else {
    verdict = 'good'; badge = 'Just right'; badgeClass = 'is-good';
    headline = `Right in the market sweet spot`;
    detail = `Competitive and profitable versus ${comps.length} live listings. Hold here and monitor for competitor moves.`;
  }
  return { median, low: stats.low, high: stats.high, pos, deltaPct, margin, suggested, suggestedMargin, verdict, badge, badgeClass, headline, detail, cheaper };
}

/* ============================================================
   MARKETPLACE FEES — true profit after Amazon/Walmart/eBay take
   Referral rates approximate published 2024 marketplace schedules.
   ============================================================ */
const AMAZON_REFERRAL = { electronics: 0.08, beauty: 0.08, fashion: 0.17, home: 0.15, toys: 0.15, music: 0.15, media: 0.15, general: 0.15 };
const WALMART_REFERRAL = { electronics: 0.08, beauty: 0.08, fashion: 0.15, home: 0.15, toys: 0.15, music: 0.15, media: 0.15, general: 0.12 };

function computeFees(channel, price, cost, category, fbaFee) {
  let referralRate = 0, perOrder = 0, fulfill = 0, label = 'Direct';
  if (channel === 'amazon') { referralRate = AMAZON_REFERRAL[category] ?? 0.15; fulfill = fbaFee || 0; label = 'Amazon FBA'; }
  else if (channel === 'walmart') { referralRate = WALMART_REFERRAL[category] ?? 0.12; label = 'Walmart'; }
  else if (channel === 'ebay') { referralRate = 0.1325; perOrder = 0.40; label = 'eBay'; }
  const referral = price * referralRate;
  const totalFees = referral + perOrder + fulfill;
  const net = price - cost - totalFees;
  const netMargin = price > 0 ? (net / price) * 100 : 0;
  return { channel, label, referralRate, referral, perOrder, fulfill, totalFees, net, netMargin };
}

/* ============================================================
   GAUGE (SVG semicircle, value 0..100)
   ============================================================ */
function renderGauge(el, value, opts = {}) {
  if (!el) return;
  const v = Math.max(0, Math.min(100, value));
  const W = 220, H = 130, cx = W / 2, cy = 116, r = 92;
  const polar = (ang) => [cx + r * Math.cos(ang), cy - r * Math.sin(ang)];
  const ang = (p) => Math.PI + (0 - Math.PI) * (p / 100);
  const arc = (from, to, color, width) => {
    const [x0, y0] = polar(ang(from)), [x1, y1] = polar(ang(to));
    return `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  };
  const zone = (verdict) => verdict === 'high' ? 'var(--color-destructive)' : verdict === 'low' ? 'var(--color-warn)' : 'var(--color-good)';
  const labelColor = opts.verdict ? zone(opts.verdict) : 'var(--color-primary)';
  const [nx, ny] = polar(ang(v));
  el.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="presentation">
    ${arc(0, 35, 'color-mix(in srgb, var(--color-warn) 38%, var(--color-muted))', 12)}
    ${arc(35, 65, 'color-mix(in srgb, var(--color-good) 42%, var(--color-muted))', 12)}
    ${arc(65, 100, 'color-mix(in srgb, var(--color-destructive) 42%, var(--color-muted))', 12)}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${labelColor}" stroke-width="4" stroke-linecap="round" class="gauge__needle"/>
    <circle cx="${cx}" cy="${cy}" r="7" fill="${labelColor}"/>
    <text x="${cx}" y="${cy - 28}" text-anchor="middle" font-family="var(--font-mono)" font-size="26" font-weight="700" fill="var(--color-foreground)">${Math.round(v)}</text>
    <text x="${cx}" y="${cy - 12}" text-anchor="middle" font-family="var(--font-sans)" font-size="10" fill="var(--color-muted-fg)">PRICE SCORE</text>
    <text x="22" y="${cy + 12}" text-anchor="middle" font-size="9" fill="var(--color-muted-fg)" font-family="var(--font-mono)">LOW</text>
    <text x="${W - 22}" y="${cy + 12}" text-anchor="middle" font-size="9" fill="var(--color-muted-fg)" font-family="var(--font-mono)">HIGH</text>
  </svg>`;
}

/* ============================================================
   SEARCH FLOW
   ============================================================ */
let currentSearch = null;   // { item, comps, stats }
let CONFIG = { liveSearch: false, stripeConfigured: false };
let lastQuery = '';

/* ---- SerpAPI key (Google Shopping, all categories) stored locally ---- */
const getSerpKey = () => localStorage.getItem('pp-serp') || '';
function updateConnectUI() {
  const on = !!getSerpKey();
  const status = $('serpStatus'), clearBtn = $('serpClear'), label = $('connectLabel');
  status.textContent = on ? '✓ Connected — live Google Shopping prices for every category' : 'Not connected — tech shows live Newegg prices; other categories link out.';
  status.className = 'connect__status ' + (on ? 'is-on' : 'is-off');
  clearBtn.hidden = !on;
  label.textContent = on ? 'Google Shopping connected (all categories) — manage' : 'Connect Google Shopping — real prices for every category';
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    CONFIG = await r.json();
  } catch (e) { /* offline / file:// — stays in default */ }
  setSourceBadge(CONFIG.liveSearch ? 'auto' : 'mock');
}

function setSourceBadge(source) {
  const src = $('searchSrc');
  const map = {
    serpapi: ['var(--color-good)', 'Live Google Shopping — all categories'],
    itunes: ['var(--color-good)', 'Live Apple Store prices'],
    newegg: ['var(--color-good)', 'Live Newegg prices'],
    reverb: ['var(--color-good)', 'Live Reverb prices'],
    ebay: ['var(--color-good)', 'Live eBay prices'],
    auto: ['var(--color-good)', 'Live marketplace prices'],
    connect: ['var(--color-secondary)', 'Connect Google Shopping for this category'],
    mock: ['var(--color-secondary)', 'Demo prices — live source unavailable'],
  };
  const [color, label] = map[source] || map.mock;
  src.innerHTML = `<span class="pill__dot" style="background:${color}"></span> ${label}`;
}

let ACCOUNT = { loggedIn: false, email: null, paid: false, subId: '' };
const BOSS_EMAIL = 'jeffyjeffydude9@gmail.com';
const BOSS_QUOTES = ["You're doing great 🚀", 'Crushing it, boss 💪', 'Empire mode: ON 👑', 'Big moves today 📈', 'The grind pays off 🔥', 'Built different, boss 🧠', 'Yo MC Blood Stain in the building 🎤'];
const getPaid = () => (ACCOUNT && ACCOUNT.paid) || localStorage.getItem('pp-paid') === '1';

/* Lightweight, dependency-free confetti pop. */
function confettiPop() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2000';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const W = c.width = innerWidth, H = c.height = innerHeight;
  const colors = ['#1E40AF', '#3B82F6', '#D97706', '#15803D', '#F59E0B', '#DC2626', '#FFFFFF'];
  const parts = [];
  for (let i = 0; i < 180; i++) parts.push({
    x: W / 2 + (Math.random() - .5) * 140, y: H * 0.4,
    vx: (Math.random() - .5) * 13, vy: Math.random() * -15 - 4,
    g: 0.32 + Math.random() * 0.2, s: 6 + Math.random() * 7,
    rot: Math.random() * 6, vr: (Math.random() - .5) * 0.4, col: colors[i % colors.length],
  });
  let t = 0; const max = 150;
  (function frame() {
    t++; ctx.clearRect(0, 0, W, H);
    parts.forEach(p => {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / max); ctx.fillStyle = p.col;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    });
    if (t < max) requestAnimationFrame(frame); else c.remove();
  })();
}

async function doSearch(query, opts = {}) {
  if (!query.trim()) return;
  const btn = $('searchBtn');
  btn.querySelector('.btn__label').textContent = 'Scanning…';
  btn.disabled = true;
  $('results').classList.add('is-loading');
  showSkeletonListings();
  $('resTag').hidden = false; $('resTag').className = 'tag'; $('resTag').textContent = 'Scanning the web…';

  try {
    lastQuery = query;
    const r = await fetch('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, serpApiKey: getSerpKey(), paid: getPaid() ? 1 : '', auto: opts.auto ? 1 : '' })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Search failed');

    // Freemium gate
    if (data.mode === 'paywall') { showPaywall(); return; }
    if (typeof data.freeRemaining === 'number') {
      if (data.freeRemaining <= 0) toast('Last free search used', 'Upgrade for unlimited searches.', '');
      else toast(`${data.freeRemaining} free search${data.freeRemaining === 1 ? '' : 'es'} left`, 'Upgrade anytime for unlimited.', '', 3000);
    }

    currentSearch = data;
    renderDetected(data);

    // No free marketplace for this category → prompt to connect, never fake numbers.
    if (data.mode === 'connect' || data.mode === 'links' || !data.comps || !data.comps.length) {
      renderConnectPrompt(data);
      setSourceBadge('connect');
      $('resTag').hidden = false; $('resTag').className = 'tag'; $('resTag').textContent = 'Needs a source';
      $('resSub').innerHTML = `Detected item · no free price feed for this category yet`;
      return;
    }

    // Seed the user's numbers from the market so the verdict is meaningful.
    $('inPrice').value = round2(data.stats.median * 1.12).toFixed(2); // 12% above → demonstrates "too high"
    $('inCost').value = round2(data.stats.median * 0.5).toFixed(2);

    setResultBlocks('prices');
    renderResults();
    setSourceBadge(data.source);
    const srcMap = { newegg: 'live Newegg', ebay: 'live eBay', itunes: 'live Apple Store', serpapi: 'live Google Shopping' };
    const srcLabel = srcMap[data.source] || 'live';
    $('resSub').innerHTML = `Benchmarked against <b>${data.stats.count}</b> real listings · ${srcLabel} · ${data.ms}ms`;
  } catch (e) {
    toast('Search failed', e.message || 'Could not reach the search service. Is the backend running?', 'error');
    $('resTag').hidden = true;
  } finally {
    btn.querySelector('.btn__label').textContent = 'Analyze';
    btn.disabled = false;
    $('results').classList.remove('is-loading');
  }
}

function renderDetected(data) {
  const it = data.item;
  const attrs = (it.attributes || []).map(a => `<span class="attr"><span>${a.label}</span><b>${escapeHtml(a.value)}</b></span>`).join('');
  $('detected').innerHTML = `
    <div class="detected__name">${escapeHtml(it.name)}</div>
    <div class="detected__cat">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>
      ${it.category}
    </div>
    <div class="detected__attrs">${attrs || '<span class="attr"><span>no specs parsed</span></span>'}</div>`;
}

// result-blocks: [0] bar chart, [1] listings, [2] margin meter
const RESULT_BLOCKS = () => $('results').querySelectorAll('.result-block');
function setResultBlocks(mode) {
  const blocks = RESULT_BLOCKS();
  if (mode === 'links') {           // only the listings block (repurposed for links)
    if (blocks[0]) blocks[0].style.display = 'none';
    if (blocks[2]) blocks[2].style.display = 'none';
    if (blocks[1]) blocks[1].style.display = '';
  } else {
    blocks.forEach(b => { b.style.display = ''; });
  }
}

function renderConnectPrompt(data) {
  setResultBlocks('links'); // hides chart + margin, keeps one block for the message
  $('resName').textContent = data.item.name;
  const badge = $('verdictBadge'); badge.textContent = 'Connect a source'; badge.className = 'result-verdict__badge';
  $('verdictHeadline').textContent = `No free price database covers “${data.item.category}” yet`;
  $('verdictDetail').textContent = `Tech (Newegg), music gear (Reverb) and media (Apple) work with no setup. For ${data.item.category} items, connect Google Shopping once (free key) and real prices for this — and every — category load straight into the page.`;
  $('reco').hidden = true;
  $('mainGauge').innerHTML = `<div style="display:grid;place-items:center;height:120px;color:var(--color-muted-fg)">
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg></div>`;
  $('kpis').innerHTML = '';
  const block = RESULT_BLOCKS()[1];
  block.querySelector('h4').textContent = 'Get real prices for this item';
  $('listingsHint').textContent = '';
  $('listings').innerHTML = `
    <div style="padding:1rem;text-align:center">
      <button type="button" class="btn btn--primary" id="connectFromResult">Connect Google Shopping (free)</button>
      <p class="demo__hint" style="margin-top:.7rem">100 free searches/month · no credit card · works for every category</p>
    </div>`;
  const b = $('connectFromResult');
  if (b) b.addEventListener('click', openConnect);
}

function renderResults() {
  if (!currentSearch || !currentSearch.comps || !currentSearch.comps.length) return;
  const price = parseFloat($('inPrice').value) || 0;
  const cost = parseFloat($('inCost').value) || 0;
  const r = analyzeMarket({ price, cost, stats: currentSearch.stats, comps: currentSearch.comps });

  $('resName').textContent = currentSearch.item.name;
  const tag = $('resTag'); tag.hidden = false; tag.textContent = r.badge; tag.className = 'tag tag--' + r.verdict;

  const badge = $('verdictBadge'); badge.textContent = r.badge; badge.className = 'result-verdict__badge ' + r.badgeClass;
  $('verdictHeadline').textContent = r.headline;
  $('verdictDetail').textContent = r.detail;
  renderGauge($('mainGauge'), r.pos, { verdict: r.verdict });
  animateNeedle($('mainGauge'));

  $('reco').hidden = false;
  $('recoPrice').textContent = fmt(r.suggested);

  // Marketplace fees → true profit after the channel's cut.
  const channel = $('inChannel').value;
  const fbaFee = parseFloat($('inFba').value) || 0;
  const category = currentSearch.item.category;
  $('fbaFeeField').hidden = channel !== 'amazon';
  const f = computeFees(channel, price, cost, category, fbaFee);
  const fSugg = computeFees(channel, r.suggested, cost, category, fbaFee);

  const deltaCls = r.deltaPct > 1 ? 'up' : r.deltaPct < -1 ? 'down' : 'flat';
  const deltaSign = r.deltaPct > 0 ? '+' : '';
  // When a marketplace is selected, the third KPI shows NET margin after fees.
  const showNet = channel !== 'direct';
  const marginVal = showNet ? f.netMargin : r.margin;
  const marginLabel = showNet ? `Net margin (${f.label})` : 'Your margin';
  const marginCls = marginVal >= 25 ? 'up' : marginVal >= 10 ? 'flat' : 'down';
  const marginNote = showNet
    ? (cost > 0 ? `${fmt(f.net)}/unit after fees` : 'add cost for net profit')
    : (r.margin >= 30 ? 'healthy' : r.margin >= 15 ? 'thin' : 'at risk');
  $('kpis').innerHTML = [
    kpi('Your price', fmt(price), `${deltaSign}${r.deltaPct.toFixed(1)}% vs median`, deltaCls),
    kpi('Market median', fmt(r.median), `range ${fmt(r.low)}–${fmt(r.high)}`, 'flat'),
    kpi(marginLabel, marginVal.toFixed(1) + '%', marginNote, marginCls),
    kpi('Cheaper rivals', `${r.cheaper}/${currentSearch.comps.length}`, r.cheaper > currentSearch.comps.length / 2 ? 'undercut' : 'competitive', r.cheaper > currentSearch.comps.length / 2 ? 'down' : 'up'),
  ].join('');

  renderBars(r, price);
  renderListings(currentSearch.comps, price);

  // Margin meter reflects the suggested price (net of fees when a channel is set).
  const mPct = Math.max(0, Math.min(100, showNet ? fSugg.netMargin : r.suggestedMargin));
  $('marginFill').style.width = mPct + '%';
  if (cost <= 0) {
    $('marginHint').textContent = 'add your unit cost for exact margin';
  } else if (showNet) {
    $('marginHint').textContent = `${fmt(fSugg.net)}/unit after ${f.label} fees (~${fmt(fSugg.totalFees)}/sale) · ${fSugg.netMargin.toFixed(1)}% net`;
  } else {
    $('marginHint').textContent = `${r.suggestedMargin.toFixed(1)}% margin · ${fmt(r.suggested - cost)} profit per unit`;
  }
}

function kpi(label, value, delta, cls) {
  return `<div class="kpi"><div class="kpi__label">${label}</div><div class="kpi__value">${value}</div><div class="kpi__delta ${cls}">${delta}</div></div>`;
}

function renderBars(r, yourPrice) {
  // Single source (e.g. all eBay) → number the listings; multi-source → show names.
  const platforms = new Set(currentSearch.comps.map(c => c.platform));
  const multi = platforms.size > 1;
  const items = currentSearch.comps.map(c => ({ label: c.platform, price: c.price, type: 'comp' }));
  items.push({ label: 'Median', price: r.median, type: 'median' });
  items.push({ label: 'You', price: yourPrice, type: 'you' });
  items.sort((a, b) => a.price - b.price);
  let n = 0;
  const max = Math.max(...items.map(i => i.price)) * 1.12;
  $('barChart').innerHTML = items.map(i => {
    const h = (i.price / max) * 100;
    const label = i.type === 'you' ? 'You' : i.type === 'median' ? 'Median' : (multi ? i.label : '#' + (++n));
    return `<div class="bar ${i.type === 'you' ? 'is-you' : ''}">
      <div class="bar__fill is-${i.type}" style="height:0" data-h="${h}"><span class="bar__val">${fmt(i.price)}</span></div>
      <div class="bar__label">${label}</div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    $('barChart').querySelectorAll('.bar__fill').forEach((el, i) => {
      setTimeout(() => { el.style.height = el.dataset.h + '%'; }, i * 40);
    });
  });
}

function renderListings(comps, yourPrice) {
  const block = RESULT_BLOCKS()[1];
  if (block) block.querySelector('h4').textContent = 'Comparable listings found';
  const lowest = Math.min(...comps.map(c => c.price));
  $('listingsHint').textContent = `${comps.length} found · cheapest ${fmt(lowest)}`;
  $('listings').innerHTML = comps.slice(0, 7).map(c => `
    <a class="listing" href="${escapeAttr(c.url)}" target="_blank" rel="noopener noreferrer">
      <span class="listing__plat">${escapeHtml(c.platform)}</span>
      <span class="listing__title">${escapeHtml(c.title)}</span>
      <span class="listing__cond">${escapeHtml(c.condition || 'New')}</span>
      <span class="listing__price ${c.price === lowest ? 'is-low' : ''}">${fmt(c.price)}</span>
    </a>`).join('');
}

function showSkeletonListings() {
  $('listings').innerHTML = Array.from({ length: 5 }).map(() =>
    `<div class="listing"><div class="skeleton" style="height:14px;width:100%"></div></div>`).join('');
}

function animateNeedle(gaugeEl) {
  const needle = gaugeEl.querySelector('.gauge__needle');
  if (!needle || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  needle.style.transition = 'none'; needle.style.transformOrigin = '110px 116px'; needle.style.transform = 'rotate(-90deg)';
  requestAnimationFrame(() => { needle.style.transition = 'transform .7s cubic-bezier(.22,.61,.36,1)'; needle.style.transform = 'rotate(0deg)'; });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

/* Search events */
$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('searchInput').value); });
['inPrice', 'inCost', 'inFba'].forEach(id => $(id).addEventListener('input', () => { if (currentSearch) renderResults(); }));
$('inChannel').addEventListener('change', () => { if (currentSearch) renderResults(); });
$('applyReco').addEventListener('click', () => {
  if (!currentSearch) return;
  const r = analyzeMarket({ price: parseFloat($('inPrice').value) || 0, cost: parseFloat($('inCost').value) || 0, stats: currentSearch.stats, comps: currentSearch.comps });
  $('inPrice').value = r.suggested.toFixed(2);
  renderResults();
  toast('Price applied', `Set to the suggested ${fmt(r.suggested)} — your margin stays healthy.`, 'success');
});

/* Example chips */
const EXAMPLES = ['RTX 5090', 'CeraVe moisturizer', 'Nike Air Force 1', 'Pokemon booster box', 'Stanley tumbler'];
$('exampleChips').innerHTML = EXAMPLES.map(q => `<button type="button" class="chip" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join('');
$('exampleChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('searchInput').value = b.dataset.q;
  doSearch(b.dataset.q);
});

/* ---- Connect Google Shopping (SerpAPI key, stored locally) ---- */
function openConnect() {
  $('connectBody').hidden = false;
  $('connectToggle').setAttribute('aria-expanded', 'true');
  document.querySelector('.connect').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('serpKey').focus(), 400);
}
$('connectToggle').addEventListener('click', () => {
  const body = $('connectBody');
  body.hidden = !body.hidden;
  $('connectToggle').setAttribute('aria-expanded', String(!body.hidden));
});
$('serpSave').addEventListener('click', () => {
  const k = $('serpKey').value.trim();
  if (!k) { $('serpStatus').textContent = 'Paste a key first.'; $('serpStatus').className = 'connect__status is-off'; return; }
  localStorage.setItem('pp-serp', k);
  $('serpKey').value = '';
  updateConnectUI();
  toast('Google Shopping connected', 'Real prices for every category are on. Re-running your search…', 'success');
  if (lastQuery) doSearch(lastQuery);
});
$('serpClear').addEventListener('click', () => {
  localStorage.removeItem('pp-serp');
  updateConnectUI();
  toast('Disconnected', 'Back to free sources (tech, music gear, media).', '');
  if (lastQuery) doSearch(lastQuery);
});

/* ============================================================
   CHECKOUT (real Stripe)
   ============================================================ */
async function buyPlan(plan, btn) {
  if (plan === 'starter' || !plan) { $('demo').scrollIntoView({ behavior: 'smooth' }); return; }
  const original = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Redirecting…'; btn.disabled = true; }
  try {
    const r = await fetch('/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan })
    });
    const data = await r.json();
    if (data.url) { window.location.href = data.url; return; }
    if (data.demo) {
      toast('Stripe not configured (demo)', `Set the STRIPE_SECRET_KEY env var on the server to enable real checkout for ${data.plan.name}.`, 'error');
    } else {
      toast('Checkout error', data.error || 'Could not start checkout.', 'error');
    }
  } catch (e) {
    toast('Checkout error', 'Could not reach the checkout service. Is the backend running?', 'error');
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

function handleCheckoutReturn() {
  const p = new URLSearchParams(location.search);
  const c = p.get('checkout');
  if (c === 'success') {
    localStorage.setItem('pp-paid', '1');          // unlock unlimited searches
    toast('Welcome aboard! 🎉', 'Your subscription is active — unlimited searches unlocked.', 'success', 6000);
  } else if (c === 'cancel') {
    toast('Checkout canceled', 'No charge was made. You can pick a plan whenever you’re ready.', 'error');
  }
  if (c) history.replaceState({}, '', location.pathname + location.hash);
}

/* ---------- Accounts / login ---------- */
let pendingAfterAuth = null;
let authMode = 'login';

async function loadAccount() {
  try { ACCOUNT = await (await fetch('/api/me')).json(); } catch (e) { /* offline */ }
  updateAccountUI();
}
function updateAccountUI() {
  $('navLogin').hidden = !!ACCOUNT.loggedIn;
  $('navAccount').hidden = !ACCOUNT.loggedIn;
  $('navCancel').hidden = !(ACCOUNT.loggedIn && ACCOUNT.subId);
  if (ACCOUNT.loggedIn) $('accEmail').textContent = ACCOUNT.email + (ACCOUNT.paid ? ' · Pro' : '');
}
$('navCancel').addEventListener('click', async () => {
  if (!confirm('Cancel your PricePilot subscription? Your unlimited access stops at the end of the billing period.')) return;
  try {
    const r = await (await fetch('/api/paypal/cancel', { method: 'POST' })).json();
    if (r.ok) { ACCOUNT.paid = false; ACCOUNT.subId = ''; localStorage.removeItem('pp-paid'); updateAccountUI(); toast('Subscription cancelled', 'No more charges. You can resubscribe anytime.', ''); }
    else toast('Could not cancel', r.error || 'Try again', 'error');
  } catch (e) { toast('Could not cancel', 'Server error', 'error'); }
});
function openAuth(mode = 'login') { authMode = mode; updateAuthUI(); $('authModal').hidden = false; setTimeout(() => $('authEmail').focus(), 100); }
function closeAuth() { $('authModal').hidden = true; $('authErr').hidden = true; }
function updateAuthUI() {
  const login = authMode === 'login';
  $('authTitle').textContent = login ? 'Log in' : 'Create account';
  $('authSubmit').textContent = login ? 'Log in' : 'Create account';
  $('authToggleText').textContent = login ? 'New to PricePilot?' : 'Already have an account?';
  $('authToggle').textContent = login ? 'Create an account' : 'Log in';
  $('authPass').autocomplete = login ? 'current-password' : 'new-password';
}
$('navLogin').addEventListener('click', () => openAuth('login'));
$('authToggle').addEventListener('click', (e) => { e.preventDefault(); authMode = authMode === 'login' ? 'signup' : 'login'; updateAuthUI(); $('authErr').hidden = true; });
$('authModal').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeAuth(); });
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), password = $('authPass').value;
  const btn = $('authSubmit'), orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try {
    const res = await (await fetch('/api/' + (authMode === 'login' ? 'login' : 'signup'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
    })).json();
    if (!res.ok) { $('authErr').textContent = res.error || 'Failed'; $('authErr').hidden = false; }
    else {
      ACCOUNT = { loggedIn: true, email: res.email, paid: !!res.paid };
      updateAccountUI(); closeAuth();
      if (res.email === BOSS_EMAIL) {
        confettiPop(); setTimeout(confettiPop, 350);
        toast('Welcome back, boss 👑', BOSS_QUOTES[Math.floor(Math.random() * BOSS_QUOTES.length)], 'success', 6000);
      } else {
        toast(authMode === 'login' ? 'Welcome back' : 'Account created', res.email, 'success');
      }
      if (pendingAfterAuth) { const f = pendingAfterAuth; pendingAfterAuth = null; f(); }
    }
  } catch (_) { $('authErr').textContent = 'Could not reach server'; $('authErr').hidden = false; }
  finally { btn.disabled = false; btn.textContent = orig; }
});
$('navLogout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
  ACCOUNT = { loggedIn: false, email: null, paid: false };
  localStorage.removeItem('pp-paid'); updateAccountUI();
  toast('Logged out', 'See you soon.', '');
});

/* ---------- Purchase modal (PayPal + Stripe) ---------- */
let PAYPAL_CFG = null, paypalSdkLoaded = false;
async function loadPayPalConfig() { try { PAYPAL_CFG = await (await fetch('/api/paypal/config')).json(); } catch (e) { PAYPAL_CFG = { configured: false }; } }

function showPaywall() { $('paywall').hidden = false; setupPurchase(); }
function hidePaywall() { $('paywall').hidden = true; }

function setupPurchase() {
  const note = $('pwNote'), container = $('paypalButtons');
  if (PAYPAL_CFG && PAYPAL_CFG.configured) {
    if (ACCOUNT.loggedIn) {
      note.hidden = true;
    } else {
      note.hidden = false;
      note.innerHTML = 'Tip: <a href="#" id="pwLoginLink">log in</a> first so your unlock saves to your account.';
      const l = $('pwLoginLink');
      if (l) l.onclick = (e) => { e.preventDefault(); pendingAfterAuth = () => { if (!$('paywall').hidden) setupPurchase(); }; openAuth('login'); };
    }
    renderPayPal();
  } else {
    note.hidden = true;
    container.innerHTML = '<p class="modal__note">PayPal not configured on the server.</p>';
  }
}

function renderPayPal() {
  const container = $('paypalButtons'); container.innerHTML = '';
  const recurring = !!(PAYPAL_CFG.recurring && PAYPAL_CFG.planId);
  const go = () => {
    if (!window.paypal) { container.innerHTML = '<p class="modal__note">PayPal failed to load.</p>'; return; }
    const cfg = {
      style: { layout: 'horizontal', height: 42, color: 'gold', tagline: false },
      onError: (err) => { console.error('PayPal error:', err); toast('PayPal error', (err && err.message ? String(err.message).slice(0, 140) : 'Please try again.'), 'error', 9000); },
    };
    if (recurring) {
      // Real monthly subscription ($29/mo, auto-renews until cancelled)
      cfg.createSubscription = (data, actions) => actions.subscription.create({ plan_id: PAYPAL_CFG.planId });
      cfg.onApprove = async (data) => {
        const r = await (await fetch('/api/paypal/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptionID: data.subscriptionID })
        })).json();
        if (r.ok) { ACCOUNT.paid = true; localStorage.setItem('pp-paid', '1'); window.location.href = '/success'; }
        else toast('Subscription issue', r.error || 'Could not confirm', 'error');
      };
    } else {
      cfg.createOrder = async () => {
        const r = await (await fetch('/api/paypal/create-order', { method: 'POST' })).json();
        if (!r.ok) throw new Error(r.error || 'create failed');
        return r.id;
      };
      cfg.onApprove = async (data) => {
        const r = await (await fetch('/api/paypal/capture', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: data.orderID })
        })).json();
        if (r.ok) { ACCOUNT.paid = true; localStorage.setItem('pp-paid', '1'); window.location.href = '/success'; }
        else toast('Payment issue', r.error || 'Could not confirm payment', 'error');
      };
    }
    window.paypal.Buttons(cfg).render('#paypalButtons');
  };
  if (paypalSdkLoaded) { go(); return; }
  const params = recurring ? '&vault=true&intent=subscription' : '&currency=USD';
  const s = document.createElement('script');
  s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(PAYPAL_CFG.clientId) + params;
  s.onload = () => { paypalSdkLoaded = true; go(); };
  s.onerror = () => { container.innerHTML = '<p class="modal__note">Could not load PayPal.</p>'; };
  document.body.appendChild(s);
}

$('paywall').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) hidePaywall(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('paywall').hidden) hidePaywall(); if (!$('authModal').hidden) closeAuth(); } });

/* ---------- Toast ---------- */
let toastTimer;
function toast(title, msg, kind = '', ms = 4500) {
  const el = $('ppToast');
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-show'); setTimeout(() => { el.hidden = true; }, 300); }, ms);
}

/* ---------- Hero + extension preview gauges (static) ---------- */
renderGauge($('heroGauge'), 84, { verdict: 'high' });
renderGauge($('extGauge'), 84, { verdict: 'high' });

/* ---------- Platform logos ---------- */
const PLATFORMS = ['Amazon', 'eBay', 'Etsy', 'Shopify', 'Walmart', 'Target', 'Mercari', 'Poshmark'];
$('platformLogos').innerHTML = PLATFORMS.map(p => `<span>${p}</span>`).join('');

/* ---------- Bento features ---------- */
const ic = (path) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const FEATURES = [
  { cls: 'tile--wide tile--feature', icon: ic('<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>'), title: 'Real-time cross-platform pricing', body: 'Live prices from 8+ marketplaces, normalized for condition and bundle so you compare apples to apples — not noise.', spark: true },
  { cls: 'tile--third', icon: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), title: 'Instant verdicts', body: 'Too high, too low, or just right — in one glance.' },
  { cls: 'tile--third', icon: ic('<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>'), title: 'Smart product matching', body: 'Reads your item’s details and finds genuinely comparable listings.' },
  { cls: 'tile--mid', icon: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>'), title: 'Margin-aware suggestions', body: 'Every recommended price keeps you above your break-even and target margin — never a race to the bottom.' },
  { cls: 'tile--third', icon: ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'), title: 'Repricing alerts', body: 'Get pinged when a competitor undercuts you.' },
  { cls: 'tile--third', icon: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'), title: 'Inventory health', body: 'Flag overpriced SKUs that are clogging your stock.' },
  { cls: 'tile--third', icon: ic('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>'), title: 'Profit after fees', body: 'See true take-home after eBay & Amazon FBA fees.' },
];
$('bento').innerHTML = FEATURES.map(f => `
  <div class="tile ${f.cls} reveal">
    <div class="tile__icon">${f.icon}</div>
    <h3>${f.title}</h3>
    <p>${f.body}</p>
    ${f.spark ? `<div class="tile__spark">${miniSpark()}</div>` : ''}
  </div>`).join('');

function miniSpark() {
  const pts = [38, 30, 42, 28, 35, 22, 30, 18, 24, 12];
  const W = 260, H = 56, step = W / (pts.length - 1);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${p}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">
    <path d="${d} L ${W} ${H} L 0 ${H} Z" fill="rgba(255,255,255,.15)"/>
    <path d="${d}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* ---------- Pricing plans (wired to checkout) ---------- */
const PLANS = [
  { key: 'starter', name: 'Starter', price: '$0', per: '', desc: 'For solo sellers testing the waters.', feats: ['2 free searches per day', 'Cross-platform price comparison', 'Profit-after-fees calculator', 'Email support'], cta: 'Start free', cls: '' },
  { key: 'growth', name: 'Growth', price: '$29', per: '/mo', desc: 'For active stores protecting margins.', feats: ['Unlimited searches', 'eBay repricing', 'FBA & fee profit calculator', 'Competitor alerts', 'Priority support'], cta: 'Get Growth', cls: 'plan--popular' },
  { key: 'scale', name: 'Scale', price: '$99', per: '/mo', desc: 'For multi-channel brands & teams.', feats: ['Everything in Growth', 'API access', 'Bulk catalog scoring', 'Team seats & roles', 'Dedicated manager'], cta: 'Get Scale', cls: '' },
];
$('plans').innerHTML = PLANS.map(p => `
  <div class="plan ${p.cls} reveal">
    <div class="plan__name">${p.name}</div>
    <div class="plan__price">${p.price}<span>${p.per}</span></div>
    <p class="plan__desc">${p.desc}</p>
    <ul class="plan__feats">${p.feats.map(f => `<li>${f}</li>`).join('')}</ul>
    <button type="button" class="btn ${p.cls ? 'btn--primary' : 'btn--ghost'} btn--block" data-plan="${p.key}">${p.cta}</button>
  </div>`).join('');
$('plans').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-plan]'); if (!btn) return;
  if (btn.dataset.plan === 'starter') { $('demo').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('searchInput').focus(), 500); }
  else showPaywall();   // PayPal purchase
});

/* CTA / nav buttons that should buy or scroll */
document.querySelectorAll('.nav__cta, .cta-band .btn').forEach(b => {
  b.addEventListener('click', (e) => { e.preventDefault(); $('demo').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('searchInput').focus(), 500); });
});

/* ---------- Scroll reveal ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal, .step, .tile, .plan').forEach((el, i) => {
  el.classList.add('reveal'); el.style.transitionDelay = (i % 4) * 60 + 'ms'; io.observe(el);
});

/* ============================================================
   CONNECTED REPRICING — link eBay account, suggest & push prices
   ============================================================ */
const CHANNELS = {
  ebay: { label: 'eBay', oauth: true, keys: 'EBAY_CLIENT_ID, EBAY_CLIENT_SECRET & EBAY_RUNAME' },
  walmart: { label: 'Walmart', oauth: false, keys: 'WALMART_CLIENT_ID & WALMART_CLIENT_SECRET' },
};
let storeChannel = 'ebay';

async function refreshStoreStatus() {
  const ch = storeChannel, cfg = CHANNELS[ch];
  const status = $('storeStatus'), connectBtn = $('storeConnectBtn'), refreshBtn = $('storeRefreshBtn');
  $('storeListings').innerHTML = '';
  let s;
  try { s = await (await fetch(`/api/${ch}/status`)).json(); }
  catch (e) { status.textContent = 'Backend offline — start the Python server to use repricing.'; connectBtn.hidden = true; refreshBtn.hidden = true; return; }

  if (!s.appConfigured) {
    status.className = 'store__status';
    status.innerHTML = `${cfg.label} not configured. Set <code>${cfg.keys}</code> on the server, then reload.`;
    connectBtn.hidden = true; refreshBtn.hidden = true;
    return;
  }
  if (cfg.oauth && !s.connected) {
    status.className = 'store__status';
    status.textContent = `Your ${cfg.label} account is not connected yet.`;
    connectBtn.hidden = false; connectBtn.textContent = `Connect ${cfg.label} account`; refreshBtn.hidden = true;
    return;
  }
  status.className = 'store__status is-on';
  status.innerHTML = `<span class="pill__dot"></span> ${cfg.label} connected`;
  connectBtn.hidden = true; refreshBtn.hidden = false;
  loadStoreListings();
}

$('storeTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.store__tab'); if (!t) return;
  storeChannel = t.dataset.channel;
  $('storeTabs').querySelectorAll('.store__tab').forEach(x => x.classList.toggle('is-active', x === t));
  refreshStoreStatus();
});
$('storeConnectBtn').addEventListener('click', () => { if (CHANNELS[storeChannel].oauth) window.location.href = `/api/${storeChannel}/connect`; });
$('storeRefreshBtn').addEventListener('click', loadStoreListings);

async function loadStoreListings() {
  const ch = storeChannel, cfg = CHANNELS[ch];
  const wrap = $('storeListings');
  wrap.innerHTML = '<div class="store__empty">Loading your listings…</div>';
  let data;
  try { data = await (await fetch(`/api/${ch}/listings`)).json(); }
  catch (e) { wrap.innerHTML = '<div class="store__empty">Could not load listings.</div>'; return; }
  if (!data.ok) { wrap.innerHTML = `<div class="store__empty">${escapeHtml(data.error || 'Could not load listings')}</div>`; return; }
  if (!data.listings.length) { wrap.innerHTML = `<div class="store__empty">No active listings found on this ${cfg.label} account.</div>`; return; }

  wrap.innerHTML = data.listings.map((l, i) => `
    <div class="srow" data-id="${escapeAttr(l.itemId)}" data-price="${l.price}" id="srow-${i}">
      <div class="srow__title"><a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title)}</a></div>
      <div class="srow__price">${fmt(l.price)}<span>current</span></div>
      <div class="srow__sugg" data-sugg>—<span>suggested</span></div>
      <button type="button" class="btn btn--ghost btn--sm" data-act="analyze">Analyze</button>
    </div>`).join('')
    + `<p class="store__note">PricePilot benchmarks each listing against the live market. Nothing is changed on ${cfg.label} until you confirm each price.</p>`;

  wrap.querySelectorAll('.srow').forEach(row => {
    row.querySelector('[data-act="analyze"]').addEventListener('click', () => analyzeRow(row));
  });
}

async function analyzeRow(row) {
  const cfg = CHANNELS[storeChannel];
  const title = row.querySelector('.srow__title').textContent.trim();
  const current = parseFloat(row.dataset.price) || 0;
  const btn = row.querySelector('button');
  btn.textContent = 'Analyzing…'; btn.disabled = true;
  try {
    const data = await (await fetch('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: title, serpApiKey: getSerpKey(), paid: 1, auto: 1 })
    })).json();
    if (data.mode !== 'prices') {
      row.querySelector('[data-sugg]').innerHTML = 'no market data<span>suggested</span>';
      btn.textContent = 'Analyze'; btn.disabled = false; return;
    }
    const r = analyzeMarket({ price: current, cost: 0, stats: data.stats, comps: data.comps });
    const dir = r.suggested > current ? 'up' : r.suggested < current ? 'down' : '';
    const suggEl = row.querySelector('[data-sugg]');
    suggEl.className = 'srow__sugg ' + dir;
    suggEl.innerHTML = `${fmt(r.suggested)}<span>median ${fmt(r.median)}</span>`;
    row._suggested = r.suggested;
    btn.textContent = `Apply to ${cfg.label}`; btn.disabled = false;
    btn.className = 'btn btn--accent btn--sm';
    btn.onclick = () => applyRow(row);
  } catch (e) {
    row.querySelector('[data-sugg]').innerHTML = 'error<span>suggested</span>';
    btn.textContent = 'Analyze'; btn.disabled = false;
  }
}

async function applyRow(row) {
  const ch = storeChannel, cfg = CHANNELS[ch];
  const itemId = row.dataset.id, price = row._suggested;
  if (!price) return;
  if (!confirm(`Update this ${cfg.label} listing's price to ${fmt(price)}?\n\nThis changes the live price on your ${cfg.label} account.`)) return;
  const btn = row.querySelector('button');
  btn.textContent = 'Updating…'; btn.disabled = true;
  try {
    const res = await (await fetch(`/api/${ch}/reprice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, price, confirm: true })
    })).json();
    if (res.ok) {
      toast(`Price updated on ${cfg.label}`, res.message || `Set to ${fmt(price)}`, 'success');
      row.querySelector('.srow__price').innerHTML = `${fmt(price)}<span>current</span>`;
      row.dataset.price = price;
      btn.textContent = 'Done ✓';
    } else {
      toast('Update failed', res.error || res.message || `${cfg.label} rejected the change`, 'error');
      btn.textContent = `Apply to ${cfg.label}`; btn.disabled = false;
    }
  } catch (e) {
    toast('Update failed', 'Could not reach the server.', 'error');
    btn.textContent = `Apply to ${cfg.label}`; btn.disabled = false;
  }
}

function handleEbayReturn() {
  const p = new URLSearchParams(location.search);
  const e = p.get('ebay');
  if (e === 'connected') toast('eBay connected 🎉', 'Your store is linked. Loading your listings…', 'success', 6000);
  else if (e === 'error') toast('eBay connection failed', 'Authorization didn’t complete. Try connecting again.', 'error');
  else if (e === 'notconfigured') toast('eBay not set up yet', 'Add your eBay app keys (App ID, Cert ID, RuName) on the server, then reconnect.', 'error', 7000);
  if (e) history.replaceState({}, '', location.pathname + location.hash);
}

/* ---------- Init ---------- */
updateConnectUI();
loadConfig();
loadAccount();
loadPayPalConfig();
handleCheckoutReturn();
handleEbayReturn();
refreshStoreStatus();
// Pre-run a search so the demo isn't empty on load (doesn't count against the free limit).
doSearch('RTX 5090', { auto: true });
