import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// When running in GitHub Actions, API_BASE is the Vercel URL.
// When running locally, it falls back to the local server.
const API_BASE = process.env.API_BASE || 'http://localhost:3001';

const SECTIONS = [
  { id: 'israel',      label: 'Israel & Region',   lang: 'en' },
  { id: 'geopolitics', label: 'Global Geopolitics', lang: 'en' },
  { id: 'markets',     label: 'Markets & Economy',  lang: 'en' },
  { id: 'tech',        label: 'Tech & AI',          lang: 'en' },
  { id: 'startups',    label: 'Startups & VC',      lang: 'en' },
  { id: 'sports',      label: 'Sports',             lang: 'en' },
  { id: 'science',     label: 'Science & Health',   lang: 'en' },
];

function loadFeedback() {
  const p = join(__dir, 'feedback.json');
  if (!existsSync(p)) return { votes: {} };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { votes: {} }; }
}

function feedbackContext(fb) {
  const liked = [], disliked = [];
  for (const [topic, score] of Object.entries(fb.votes)) {
    if (score > 0) liked.push(topic);
    else if (score < 0) disliked.push(topic);
  }
  const parts = [];
  if (liked.length) parts.push(`Reader has previously liked: ${liked.join(', ')}.`);
  if (disliked.length) parts.push(`Reader has previously disliked: ${disliked.join(', ')}.`);
  return parts.join(' ');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function tavilySearch(query, opts = {}) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
      days: 2,
      include_raw_content: false,
      ...opts,
    }),
  });
  if (!r.ok) throw new Error(`Tavily error: ${r.status}`);
  return await r.json();
}

async function fetchMapImage(mapQuery) {
  try {
    const data = await tavilySearch(`${mapQuery} map infographic`, {
      max_results: 5, days: 7, include_images: true,
    });
    const images = (data.images ?? []).filter(url =>
      !url.match(/logo|avatar|icon|profile|thumb|favicon|sprite|author|headshot/i) &&
      url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)
    );
    return images[0] ?? null;
  } catch { return null; }
}

async function fetchNewspaper(dateStr, fbCtx) {
  console.log('  Searching the web...');

  const [israelGeneral, israelSources, geo, markets, marketIndices, commodities, tech, startups, sports, sportsScores, science] = await Promise.all([
    tavilySearch(`Israel Lebanon Gaza military news ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
    tavilySearch(`Israel IDF news today`, {
      max_results: 5, days: 2,
      include_domains: ['timesofisrael.com', 'jpost.com', 'i24news.tv', 'haaretz.com', 'ynetnews.com'],
    }).catch(() => ({ results: [] })),
    tavilySearch(`Global geopolitics diplomacy news ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
    tavilySearch(`Markets economy finance earnings news ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
    tavilySearch(`S&P 500 NASDAQ Dow Jones performance ${dateStr}`, { max_results: 4, days: 1 }).catch(() => ({ results: [] })),
    tavilySearch(`oil gold bitcoin commodities price ${dateStr}`, { max_results: 4, days: 1 }).catch(() => ({ results: [] })),
    tavilySearch(`Technology AI news ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
    tavilySearch(`Startups venture capital funding ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
    tavilySearch(`NBA NFL MLB NHL game results scores ${dateStr}`, { max_results: 5, days: 1 }).catch(() => ({ results: [] })),
    tavilySearch(`sports box scores game recap highlights ${dateStr}`, { max_results: 4, days: 1 }).catch(() => ({ results: [] })),
    tavilySearch(`Science health medical research breakthrough ${dateStr}`, { max_results: 5, days: 2 }).catch(() => ({ results: [] })),
  ]);

  // Merge and deduplicate Israel results, Israeli sources first
  const israelUrls = new Set();
  const israelResults = [
    ...(israelSources.results ?? []),
    ...(israelGeneral.results ?? []),
  ].filter(r => { if (israelUrls.has(r.url)) return false; israelUrls.add(r.url); return true; }).slice(0, 8);

  // Merge sports results
  const sportsUrls = new Set();
  const sportsResults = [
    ...(sportsScores.results ?? []),
    ...(sports.results ?? []),
  ].filter(r => { if (sportsUrls.has(r.url)) return false; sportsUrls.add(r.url); return true; }).slice(0, 7);

  function fmt(results) {
    if (!results?.length) return 'No results.';
    return results.map(r => `### ${r.title}\n${(r.content ?? '').slice(0, 220)}\nSource: ${r.url}`).join('\n\n');
  }

  const marketsContext = `${fmt(markets.results)}\n\n### Market Indices Data\n${fmt(marketIndices.results)}\n\n### Commodities & Crypto\n${fmt(commodities.results)}`;
  const context1 = `## Israel & Region\n${fmt(israelResults)}\n\n---\n\n## Global Geopolitics\n${fmt(geo.results)}\n\n---\n\n## Markets & Economy\n${marketsContext}\n\n---\n\n## Tech & AI\n${fmt(tech.results)}`;
  const context2 = `## Startups & VC\n${fmt(startups.results)}\n\n---\n\n## Sports\n${fmt(sportsResults)}\n\n---\n\n## Science & Health\n${fmt(science.results)}`;

  const sharedRules = `${fbCtx ? fbCtx + '\n\n' : ''}WRITING RULES — read carefully:

DEPTH: Each paragraph must be 5–7 dense sentences. "Israel & Region" paragraphs must be 6–8 sentences. No paragraph should be writeable without reading today's search results.

SPECIFICITY: Name every person, unit, location, number, and quote that appears in the search results. "An IDF source said" is only acceptable if no name is available. If a name is available, use it.

NO FILLER: Do not explain what Hamas is, what the Fed does, or what a startup is. State the significance directly.

REPORTS & BRIEFS: Never lead with "a report was released." Lead with the most striking specific finding.

OP-EDS: Name the author and their institutional affiliation in the first sentence. State their specific argument, not their topic.

EMPTY SECTIONS: If a section has no genuine news, omit it (return empty stories array). Do not pad.

ISRAEL SECTION: Write at minimum 3 stories, all in English. If both Gaza and Lebanon have developments, they are ALWAYS separate stories. Prefer IDF Spokesperson statements and Israeli outlets.

MARKETS SECTION: This section must include at least 2 charts — one showing major index performance (S&P 500, NASDAQ, Dow — use today's closing levels or % change), and one showing a commodity or sector move. Use exact figures with units. Each story covering a market move should have a chart.

SPORTS SECTION: Cover ONLY games that have been played and completed in the last 24 hours. Include the final score in the headline. No TV schedules, no upcoming games, no promotional content. For each completed game, include a bar chart showing the final scores for both teams. If no games were played in the last 24 hours, omit this section entirely.

CHARTS: Use exact figures, not rounded numbers. Include the unit in the title (e.g. "S&P 500 Closing Level" not just "S&P 500"). Tight y-axis around the data range. Up to 8 data points. Can use widely-known public data (index levels, market caps). Include a "source" field.

SOURCES: For each story, include 1–3 sources from the search results provided above.

MAP: For geographic/conflict stories, include "map_query" specific enough to find a news infographic (e.g. "IDF ground forces southern Lebanon advance 2026").`;

  const schema = `\`\`\`json
[
  {
    "id": "israel",
    "label": "Israel & Region",
    "stories": [
      {
        "headline": "Specific headline naming the event",
        "paragraphs": ["Paragraph 1 — 6-8 sentences with specific details", "Paragraph 2 — 6-8 sentences with analysis"],
        "sources": [{"title": "Times of Israel", "url": "https://..."}],
        "map_query": "IDF ground operation southern Lebanon 2026",
        "chart": {"type": "bar", "title": "...", "label": "...", "labels": ["..."], "values": [0], "source": "Bloomberg"}
      }
    ]
  }
]
\`\`\``;

  const makePrompt = (ctx, sectionIds) => `Today is ${dateStr}.\n\nSEARCH RESULTS:\n---\n${ctx}\n---\n\n${sharedRules}\n\nWrite sections: ${sectionIds.join(', ')}. Return a JSON array in a \`\`\`json block:\n${schema}`;

  // Run sequentially to stay within Groq's per-minute token limit
  console.log('  Writing sections 1–4...');
  const r1 = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: makePrompt(context1, ['israel', 'geopolitics', 'markets', 'tech']) }],
    max_tokens: 7000, temperature: 0.5,
  });

  console.log('  Writing sections 5–7...');
  const r2 = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: makePrompt(context2, ['startups', 'sports', 'science']) }],
    max_tokens: 3500, temperature: 0.5,
  });

  function extract(text) {
    // Try standard closed code block
    let m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        return Array.isArray(p) ? p : (p.sections ?? []);
      } catch {}
    }
    // Fallback: output was truncated — grab everything after the opening fence
    m = text.match(/```(?:json)?\s*([\s\S]+)/);
    const raw = m ? m[1] : text;
    // Rescue complete section objects from partial JSON
    const rescued = [];
    const sectionRe = /\{\s*"id"\s*:\s*"[^"]+[\s\S]*?\}\s*(?=[,\]]|$)/g;
    for (const sm of raw.matchAll(sectionRe)) {
      try { rescued.push(JSON.parse(sm[0])); } catch {}
    }
    if (rescued.length) {
      console.warn(`  ⚠ Output truncated — rescued ${rescued.length} section(s)`);
      return rescued;
    }
    throw new Error('No JSON:\n' + text.slice(0, 200));
  }

  const sections = [
    ...extract(r1.choices[0].message.content),
    ...extract(r2.choices[0].message.content),
  ];

  const data = { date: dateStr, sections };

  const mapJobs = [];
  for (const sec of data.sections) {
    for (const story of sec.stories ?? []) {
      if (story.map_query) {
        mapJobs.push(fetchMapImage(story.map_query).then(url => { story.map_image_url = url; }));
      }
    }
  }
  if (mapJobs.length) {
    console.log(`  Fetching ${mapJobs.length} map image(s)...`);
    await Promise.all(mapJobs);
  }

  return data;
}

function buildHTML(data) {
  const storyMap = {};

  const sectionsHTML = SECTIONS.map(sec => {
    const section = data.sections.find(s => s.id === sec.id);
    if (!section || !section.stories?.length) return '';

    const isRtl = sec.lang === 'he';

    const storiesHTML = section.stories.map((story, i) => {
      const id = `${sec.id}-${i + 1}`;
      storyMap[id] = { headline: story.headline, paragraphs: story.paragraphs };

      const sourcesHTML = story.sources?.length
        ? `<div class="story-sources">Sources: ${story.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join(' · ')}</div>`
        : '';

      const mapHTML = story.map_image_url
        ? `<figure class="map-wrap" onclick="openLightboxImg('${esc(story.map_image_url)}','${esc(story.map_query ?? '')}')">
            <img src="${esc(story.map_image_url)}" alt="${esc(story.map_query ?? 'Map')}" loading="lazy" onerror="this.closest('figure').remove()">
            <figcaption>${esc(story.map_query ?? '')} <span class="zoom-hint">click to enlarge</span></figcaption>
          </figure>`
        : '';

      let chartHTML = '';
      if (story.chart?.labels?.length && story.chart?.values?.length) {
        const chartSource = story.chart.source ? `<div class="chart-source">Source: ${esc(story.chart.source)}</div>` : '';
        chartHTML = `<div class="chart-wrap" title="Click to enlarge" onclick="openChartLightbox(this)">
          <canvas id="chart-${id}" data-chart="${esc(JSON.stringify(story.chart))}"></canvas>
          ${chartSource}
        </div>`;
      }

      return `
      <article${isRtl ? ' dir="rtl"' : ''}>
        <h3 class="headline">${esc(story.headline)}</h3>
        ${story.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}
        ${sourcesHTML}
        ${mapHTML}
        ${chartHTML}
        <div class="btn-row">
          <button class="btn" onclick="deepDive('${id}')">Deep Dive</button>
          <button class="btn" onclick="nlmPack('${id}')">NLM Pack</button>
          <span class="vote-btns">
            <button class="vote" onclick="vote('${id}',1)" title="Good story">👍</button>
            <button class="vote" onclick="vote('${id}',-1)" title="Not for me">👎</button>
          </span>
        </div>
        <div class="exp" id="exp-${id}"${isRtl ? ' dir="rtl"' : ''}></div>
      </article>`;
    }).join('');

    return `
    <section>
      <h2 class="section-head">${esc(sec.label)}</h2>
      ${storiesHTML}
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Morning Paper — ${esc(data.date)}</title>
<link href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@300;400;700;900&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root{--ink:#1a1a1a;--paper:#faf8f3;--rule:#c8b89a;--red:#8b1a1a;--muted:#555}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font-family:Georgia,'Times New Roman',serif;line-height:1.7;max-width:1200px;margin:0 auto;padding:2rem 1.5rem}
  [dir="rtl"],[dir="rtl"] p,[dir="rtl"] h3{font-family:'Frank Ruhl Libre',Georgia,serif;letter-spacing:0}
  header{text-align:center;border-top:3px solid var(--ink);border-bottom:3px solid var(--ink);padding:1.2rem 0;margin-bottom:2.5rem}
  header h1{font-size:3.2rem;font-weight:900;letter-spacing:.04em;color:var(--red)}
  header .dateline{font-size:.85rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-top:.3rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:2.5rem}
  .section-head{font-size:.75rem;letter-spacing:.2em;text-transform:uppercase;color:var(--red);border-bottom:1px solid var(--rule);padding-bottom:.4rem;margin-bottom:1.2rem}
  article{margin-bottom:2rem;padding-bottom:2rem;border-bottom:1px solid var(--rule)}
  article:last-child{border-bottom:none}
  .headline{font-size:1.15rem;font-weight:700;line-height:1.35;margin-bottom:.7rem}
  p{font-size:.95rem;margin-bottom:.8rem;color:var(--ink)}
  .story-sources{font-size:.72rem;color:var(--muted);margin-bottom:.6rem}
  .story-sources a{color:var(--red);text-decoration:none}
  .story-sources a:hover{text-decoration:underline}
  .btn-row{display:flex;align-items:center;gap:.5rem;margin-top:.6rem;flex-wrap:wrap}
  .btn{font-family:inherit;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;padding:.35rem .8rem;border:1px solid var(--ink);background:transparent;cursor:pointer;transition:background .15s,color .15s}
  .btn:hover{background:var(--ink);color:var(--paper)}
  .btn.loading{opacity:.5;pointer-events:none}
  .vote-btns{margin-left:auto;display:flex;gap:.25rem}
  .vote{background:none;border:none;cursor:pointer;font-size:1rem;padding:.1rem .3rem;border-radius:3px;transition:background .1s}
  .vote:hover{background:#e0d8c8}
  .vote.active-up{background:#d4edda}
  .vote.active-down{background:#f8d7da}
  .exp{display:none;margin-top:1rem;padding-top:1rem;border-top:1px dashed var(--rule);font-size:.93rem}
  .exp.open{display:block}
  .exp p{margin-bottom:.7rem}
  .exp .sources{margin-top:.8rem;font-size:.78rem;color:var(--muted)}
  .exp .sources a{color:var(--red);text-decoration:none}
  .exp .sources a:hover{text-decoration:underline}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--rule);border-top-color:var(--ink);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:.4rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  .map-wrap{margin:1rem 0;border:1px solid var(--rule);border-radius:3px;overflow:hidden;cursor:zoom-in}
  .map-wrap img{width:100%;display:block;max-height:320px;object-fit:cover;transition:opacity .15s}
  .map-wrap:hover img{opacity:.92}
  .map-wrap figcaption{font-size:.72rem;color:var(--muted);padding:.3rem .5rem;background:#f0ece2;font-style:italic}
  .zoom-hint{color:var(--rule);font-size:.65rem;margin-left:.4rem}
  .chart-wrap{margin:1rem 0;padding:.75rem;background:#fff;border:1px solid var(--rule);border-radius:3px;cursor:zoom-in;transition:box-shadow .15s}
  .chart-wrap:hover{box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .chart-wrap canvas{max-height:220px}
  .chart-source{font-size:.68rem;color:var(--muted);margin-top:.3rem;font-style:italic}
  /* NLM pack styles */
  .nlm-pack{font-size:.88rem}
  .nlm-section{margin-bottom:1.2rem;padding-bottom:1.2rem;border-bottom:1px solid var(--rule)}
  .nlm-section:last-child{border-bottom:none;margin-bottom:0}
  .nlm-label{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--red);margin-bottom:.5rem}
  .nlm-prompt{background:#f0ece2;padding:.8rem 1rem;border-radius:3px;white-space:pre-wrap;line-height:1.65;font-size:.85rem;margin-bottom:.5rem}
  .nlm-copy{font-size:.7rem;padding:.2rem .6rem}
  .nlm-list{list-style:none;margin-top:.5rem}
  .nlm-list li{padding:.4rem 0;border-bottom:1px solid #ede8df}
  .nlm-list li:last-child{border-bottom:none}
  .nlm-list a{color:var(--red);text-decoration:none;font-weight:600}
  .nlm-list a:hover{text-decoration:underline}
  .nlm-snippet{display:block;font-size:.75rem;color:var(--muted);margin-top:.1rem}
  .nlm-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.6rem}
  /* Lightbox */
  #lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;align-items:center;justify-content:center;padding:2rem;cursor:zoom-out}
  #lightbox.open{display:flex}
  #lb-img{max-width:90vw;max-height:88vh;object-fit:contain;border-radius:3px;box-shadow:0 0 60px rgba(0,0,0,.5)}
  #lb-chart-wrap{background:#fff;border-radius:6px;padding:1.5rem;width:min(90vw,860px);max-height:88vh}
  #lb-chart-wrap canvas{width:100%!important;max-height:70vh}
  #lb-close{position:fixed;top:1rem;right:1.5rem;background:none;border:none;color:#fff;font-size:2rem;cursor:pointer;line-height:1;opacity:.8}
  #lb-close:hover{opacity:1}
</style>
</head>
<body>
<header>
  <h1>The Morning Paper</h1>
  <div class="dateline">${esc(data.date)}</div>
</header>
<div class="grid">
${sectionsHTML}
</div>

<!-- Lightbox -->
<div id="lightbox" onclick="closeLightbox(event)">
  <img id="lb-img" src="" alt="" style="display:none">
  <div id="lb-chart-wrap" style="display:none" onclick="event.stopPropagation()">
    <canvas id="lb-canvas"></canvas>
  </div>
  <button id="lb-close" onclick="closeLightbox()">✕</button>
</div>

<script>
const S = ${JSON.stringify(storyMap)};
const API = '${API_BASE}';
let lbChart = null;

function makeChartConfig(cfg, large) {
  const minV = Math.min(...cfg.values);
  const maxV = Math.max(...cfg.values);
  const pad = (maxV - minV) * 0.18 || Math.abs(maxV) * 0.05 || 1;
  return {
    type: cfg.type || 'bar',
    data: {
      labels: cfg.labels,
      datasets: [{ label: cfg.label || '', data: cfg.values,
        backgroundColor: 'rgba(139,26,26,0.12)', borderColor: '#8b1a1a',
        borderWidth: 2, tension: 0.35, fill: cfg.type === 'line',
        pointBackgroundColor: '#8b1a1a', pointRadius: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: !large,
      plugins: {
        legend: { display: !!cfg.label, labels: { font: { family: 'Georgia', size: large?13:11 } } },
        title: { display: !!cfg.title, text: cfg.title, color: '#1a1a1a',
          font: { family: 'Georgia', size: large?15:13, weight: 'bold' } }
      },
      scales: {
        y: { min: minV - pad, max: maxV + pad, ticks: { font: { family: 'Georgia', size: large?12:10 } } },
        x: { ticks: { font: { family: 'Georgia', size: large?12:10 } } }
      }
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('canvas[data-chart]').forEach(canvas => {
    try { new Chart(canvas, makeChartConfig(JSON.parse(canvas.dataset.chart), false)); }
    catch(e) { console.warn('Chart failed', e); }
  });
});

function openLightboxImg(src, alt) {
  document.getElementById('lb-img').src = src;
  document.getElementById('lb-img').alt = alt;
  document.getElementById('lb-img').style.display = 'block';
  document.getElementById('lb-chart-wrap').style.display = 'none';
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openChartLightbox(wrap) {
  const canvas = wrap.querySelector('canvas');
  if (!canvas) return;
  const cfg = JSON.parse(canvas.dataset.chart);
  document.getElementById('lb-img').style.display = 'none';
  document.getElementById('lb-chart-wrap').style.display = 'block';
  if (lbChart) lbChart.destroy();
  lbChart = new Chart(document.getElementById('lb-canvas'), makeChartConfig(cfg, true));
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox(e) {
  if (e && e.target !== document.getElementById('lightbox') && e.target !== document.getElementById('lb-close')) return;
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
  if (lbChart) { lbChart.destroy(); lbChart = null; }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.getElementById('lightbox').classList.remove('open'); document.body.style.overflow=''; } });

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function copyText(text, btn) {
  await navigator.clipboard.writeText(text);
  const orig = btn.textContent; btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = orig, 2000);
}

async function deepDive(id) {
  const btn = event.target;
  const exp = document.getElementById('exp-' + id);
  if (exp.classList.contains('open') && exp.dataset.type === 'deep') { exp.classList.remove('open'); return; }
  btn.classList.add('loading'); btn.innerHTML = '<span class="spinner"></span>Diving...';
  try {
    const r = await fetch(API + '/deep-dive', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id, headline: S[id].headline, paragraphs: S[id].paragraphs }) });
    const d = await r.json();
    const src = d.sources?.length
      ? '<div class="sources">Sources: ' + d.sources.map(s=>\`<a href="\${escHtml(s.url)}" target="_blank">\${escHtml(s.title||s.url)}</a>\`).join(' · ') + '</div>'
      : '';
    exp.innerHTML = d.paragraphs.map(p=>\`<p>\${escHtml(p)}</p>\`).join('') + src;
    exp.dataset.type = 'deep'; exp.classList.add('open');
  } catch(e) {
    exp.innerHTML = '<p>Could not load — please try again in a moment.</p>';
    exp.dataset.type = 'deep'; exp.classList.add('open');
  }
  btn.classList.remove('loading'); btn.textContent = 'Deep Dive';
}

async function nlmPack(id) {
  const btn = event.target;
  const exp = document.getElementById('exp-' + id);
  if (exp.classList.contains('open') && exp.dataset.type === 'nlm') { exp.classList.remove('open'); return; }
  btn.classList.add('loading'); btn.innerHTML = '<span class="spinner"></span>Building...';
  try {
    const r = await fetch(API + '/nlm-pack', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id, headline: S[id].headline, paragraphs: S[id].paragraphs }) });
    const d = await r.json();
    const sourceItems = d.sources.map(s =>
      \`<li><a href="\${escHtml(s.url)}" target="_blank" rel="noopener">\${escHtml(s.title||s.url)}</a>\${s.snippet?\`<span class="nlm-snippet">\${escHtml(s.snippet)}</span>\`:''}</li>\`
    ).join('');
    const allUrls = d.sources.map(s=>s.url).join('\\n');
    exp.innerHTML = \`
      <div class="nlm-pack">
        <div class="nlm-section">
          <div class="nlm-label">NotebookLM Power Prompt</div>
          <div class="nlm-prompt" id="nlm-prompt-\${id}">\${escHtml(d.prompt)}</div>
          <div class="nlm-actions">
            <button class="btn nlm-copy" id="cp-prompt-\${id}">Copy Prompt</button>
          </div>
        </div>
        <div class="nlm-section">
          <div class="nlm-label">Sources (\${d.sources.length}) — add to NotebookLM, then paste the prompt</div>
          <div class="nlm-actions">
            <button class="btn nlm-copy" id="cp-urls-\${id}">Copy All URLs</button>
          </div>
          <ol class="nlm-list">\${sourceItems}</ol>
        </div>
      </div>\`;
    document.getElementById(\`cp-prompt-\${id}\`).addEventListener('click', function(){ copyText(d.prompt, this); });
    document.getElementById(\`cp-urls-\${id}\`).addEventListener('click', function(){ copyText(allUrls, this); });
    exp.dataset.type = 'nlm'; exp.classList.add('open');
  } catch(e) {
    exp.innerHTML = '<p>Could not load — please try again in a moment.</p>';
    exp.dataset.type = 'nlm'; exp.classList.add('open');
  }
  btn.classList.remove('loading'); btn.textContent = 'NLM Pack';
}

async function vote(id, dir) {
  const row = event.target.closest('.btn-row');
  row.querySelectorAll('.vote').forEach(b => b.classList.remove('active-up','active-down'));
  event.target.classList.add(dir===1?'active-up':'active-down');
  try { await fetch(API+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id,headline:S[id].headline,vote:dir})}); } catch(e){}
}
</script>
</body>
</html>`;
}

const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
console.log(`Fetching today's news for ${today}…`);

const data = await fetchNewspaper(today, feedbackContext(loadFeedback()));
writeFileSync(join(__dir, 'morning-paper.html'), buildHTML(data), 'utf8');
console.log(`Done. Open: ${join(__dir, 'morning-paper.html')}`);

// Write metadata for WhatsApp notification step in GitHub Actions
const meta = {
  date: today,
  headlines: data.sections
    .map(s => s.stories?.[0]?.headline)
    .filter(Boolean)
    .slice(0, 6),
};
writeFileSync(join(__dir, 'paper-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
