/* ============================================================
   PricePilot popup — runs the shared scoring model on the price
   detected by content.js, and renders the verdict.
   ============================================================ */

/* ---- Scoring model (mirrors the website's app.js) ---- */
const CATEGORY_STATS = {
  electronics: { median: 129.99, spread: 0.22, demandFloor: 0.82, demandCeil: 1.18 },
  home:        { median: 42.50,  spread: 0.28, demandFloor: 0.80, demandCeil: 1.22 },
  fashion:     { median: 38.00,  spread: 0.34, demandFloor: 0.78, demandCeil: 1.28 },
  beauty:      { median: 24.99,  spread: 0.30, demandFloor: 0.80, demandCeil: 1.25 },
  toys:        { median: 29.95,  spread: 0.26, demandFloor: 0.82, demandCeil: 1.20 },
};
function seeded(seed){let s=seed%2147483647;if(s<=0)s+=2147483646;return()=>(s=(s*16807)%2147483647)/2147483647;}
function buildCompetitors(median, spread, seed){
  const rnd=seeded(seed); const platforms=['Amazon','eBay','Walmart','Etsy','Shopify','Target'];
  return platforms.map(p=>({platform:p, price:+(median*(1+(rnd()-0.5)*spread*2)).toFixed(2)})).sort((a,b)=>a.price-b.price);
}
function analyze({price, cost, category}){
  const stats=CATEGORY_STATS[category]||CATEGORY_STATS.electronics;
  const seed=[...category].reduce((a,c)=>a+c.charCodeAt(0),0)*97+13;
  const competitors=buildCompetitors(stats.median,stats.spread,seed);
  const prices=competitors.map(c=>c.price);
  const median=stats.median, low=Math.min(...prices), high=Math.max(...prices);
  const floor=median*stats.demandFloor, ceil=median*stats.demandCeil;
  let pos=Math.max(0,Math.min(100,((price-floor)/(ceil-floor))*100));
  const deltaPct=((price-median)/median)*100;
  const margin=price>0?((price-cost)/price)*100:0;
  const marginFloorPrice=cost>0?cost/0.75:0;
  let suggested=Math.max(median, marginFloorPrice);
  suggested=Math.floor(suggested)+0.99;
  let verdict, badge, detail;
  if(deltaPct>7){verdict='high';badge='Too high';detail=`Shoppers can find ${competitors.filter(c=>c.price<price).length} cheaper comparable listings. Lowering toward the median should lift conversion.`;}
  else if(deltaPct<-7){verdict='low';badge='Too low';detail=`You're under-pricing — the market tolerates more. Raising toward the median captures margin without hurting demand.`;}
  else{verdict='good';badge='Just right';detail=`Competitive and profitable. Hold here and watch for competitor moves.`;}
  const suggestedMargin=suggested>0?((suggested-cost)/suggested)*100:0;
  return {competitors, median, low, high, pos, deltaPct, margin, suggested, suggestedMargin, verdict, badge, detail};
}

/* ---- Gauge ---- */
function renderGauge(el, value, verdict){
  const v=Math.max(0,Math.min(100,value));
  const W=200,H=118,cx=W/2,cy=104,r=82;
  const polar=a=>[cx+r*Math.cos(a),cy-r*Math.sin(a)];
  const ang=p=>Math.PI+(0-Math.PI)*(p/100);
  const arc=(f,t,c,w)=>{const[x0,y0]=polar(f),[x1,y1]=polar(t);const lg=Math.abs(t-f)>Math.PI?1:0;return `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${lg} 1 ${x1} ${y1}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;};
  const col=verdict==='high'?'var(--bad)':verdict==='low'?'var(--warn)':'var(--good)';
  const[nx,ny]=polar(ang(v));
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}">
    ${arc(ang(0),ang(30),'color-mix(in srgb,var(--warn) 40%,var(--border))',11)}
    ${arc(ang(30),ang(70),'color-mix(in srgb,var(--good) 45%,var(--border))',11)}
    ${arc(ang(70),ang(100),'color-mix(in srgb,var(--bad) 45%,var(--border))',11)}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${col}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="${col}"/>
    <text x="${cx}" y="${cy-22}" text-anchor="middle" font-family="var(--mono)" font-size="24" font-weight="700" fill="var(--fg)">${Math.round(v)}</text>
    <text x="${cx}" y="${cy-7}" text-anchor="middle" font-size="8.5" fill="var(--muted)" font-family="var(--sans)">PRICE SCORE</text>
  </svg>`;
}

/* ---- DOM ---- */
const $=id=>document.getElementById(id);
const fmt=n=>'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const WEBSITE_DEMO='https://pricepilot.app/#demo'; // replace with your deployed URL

let current = null; // detected product

function show(state){
  $('ppLoading').hidden = state!=='loading';
  $('ppEmpty').hidden = state!=='empty';
  $('ppResult').hidden = state!=='result';
}

function render(){
  if(!current || !current.price){ show('empty'); return; }
  const cost = parseFloat($('ppCost').value) || 0;
  const r = analyze({ price: current.price, cost, category: current.category });

  $('ppName').textContent = current.name;
  $('ppCat').textContent = current.category;
  $('ppBadge').textContent = r.badge;
  $('ppBadge').className = 'pp-badge is-' + r.verdict;
  renderGauge($('ppGauge'), r.pos, r.verdict);
  $('ppDetail').textContent = r.detail;
  $('ppPrice').textContent = fmt(current.price);
  $('ppMedian').textContent = fmt(r.median);
  $('ppSuggest').textContent = fmt(r.suggested);
  $('ppMargin').textContent = cost > 0
    ? `${r.suggestedMargin.toFixed(0)}% margin\n(${fmt(r.suggested - cost)}/unit)`
    : 'add cost for margin';
  show('result');
}

/* ---- Detection: ask content script, inject if needed ---- */
async function detectOnActiveTab(){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    show('empty'); $('ppFootMsg').textContent = 'Open a product page to analyze'; return;
  }
  $('ppHost').textContent = (tab.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0];

  const ask = () => new Promise(res => {
    chrome.tabs.sendMessage(tab.id, { type: 'PP_DETECT' }, resp => {
      if (chrome.runtime.lastError) res(null); else res(resp);
    });
  });

  let data = await ask();
  if (!data) {
    // content script not present (page loaded before install) — inject then retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      data = await ask();
    } catch (e) { /* restricted page */ }
  }

  if (data && data.ok) { current = data; render(); }
  else { current = data || null; show('empty'); }
}

/* ---- Events ---- */
$('ppCost').addEventListener('input', () => { if (current && current.price) render(); });

$('ppSave').addEventListener('click', () => {
  if (!current) return;
  chrome.storage.sync.get(['settings'], (res) => {
    const settings = res.settings || { targetMargin: 25, saved: [] };
    settings.saved = settings.saved || [];
    settings.saved.unshift({ ...current, savedAt: Date.now() });
    settings.saved = settings.saved.slice(0, 100);
    chrome.storage.sync.set({ settings }, () => {
      const btn = $('ppSave'); btn.textContent = '✓ Saved to workspace'; btn.disabled = true;
      setTimeout(() => { btn.textContent = 'Save to workspace'; btn.disabled = false; }, 1800);
    });
  });
});

$('ppOpen').addEventListener('click', () => {
  const q = current ? `?price=${current.price}&cat=${current.category}` : '';
  chrome.tabs.create({ url: WEBSITE_DEMO + q });
});

/* ---- Go ---- */
show('loading');
detectOnActiveTab();
