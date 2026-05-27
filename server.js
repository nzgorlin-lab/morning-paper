import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(__dir));

async function tavilySearch(query, opts = {}) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      max_results: 5,
      include_raw_content: false,
      ...opts,
    }),
  });
  if (!r.ok) return { results: [] };
  return await r.json();
}

async function callGroq(prompt, maxTokens = 4000) {
  const c = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.6,
  });
  return c.choices[0].message.content;
}

app.post('/deep-dive', async (req, res) => {
  const { headline, paragraphs } = req.body;
  const searchResults = await tavilySearch(headline, { days: 7 }).then(d => d.results ?? []).catch(() => []);

  const context = searchResults.length
    ? searchResults.map(r => `### ${r.title}\n${r.content}\nSource: ${r.url}`).join('\n\n')
    : 'No additional results found.';

  const prompt = `You are writing an in-depth follow-up for The Morning Paper.

Headline: ${headline}
Summary: ${paragraphs.join(' ')}

Additional web research:
---
${context}
---

Write 3–4 additional paragraphs (5–7 sentences each) that go deeper. Name every person, unit, figure, and quote from the sources. Right-of-center realist tone. No background filler — every sentence must add something.

Return ONLY this JSON in a \`\`\`json block:
\`\`\`json
{"paragraphs":["...","...","..."],"sources":[{"url":"https://...","title":"..."}]}
\`\`\``;

  try {
    const text = await callGroq(prompt);
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!match) return res.status(500).json({ error: 'Bad model response' });
    const parsed = JSON.parse(match[1]);
    if (!parsed.sources?.length && searchResults.length) {
      parsed.sources = searchResults.slice(0, 5).map(r => ({ url: r.url, title: r.title }));
    }
    res.json(parsed);
  } catch (e) {
    console.error('/deep-dive error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/nlm-pack', async (req, res) => {
  const { headline, paragraphs } = req.body;
  const summary = paragraphs.join(' ');

  // Search across multiple angles for diverse, open sources
  const queries = [
    `${headline} news analysis`,
    `${headline} historical background context`,
    `${headline} economic implications`,
    `${headline} geopolitical strategic analysis`,
    `${headline} official statement government`,
  ];

  const allSearches = await Promise.all(
    queries.map(q => tavilySearch(q, { days: 730, max_results: 4 }).then(d => d.results ?? []).catch(() => []))
  );

  // Flatten and deduplicate by URL
  const seen = new Set();
  const sources = allSearches.flat()
    .filter(r => {
      if (seen.has(r.url) || !r.url || !r.title) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, 15)
    .map(r => ({ url: r.url, title: r.title, snippet: (r.content ?? '').slice(0, 130) }));

  // Generate the NotebookLM power prompt
  const promptText = await callGroq(`You are writing a NotebookLM power prompt for a podcast episode on the following story:

Headline: ${headline}
Context: ${summary}

Write a power prompt that instructs the AI podcast hosts to produce a smart, layered episode. The prompt must:
1. Name the specific actors, tensions, and stakes in THIS story (not generic instructions)
2. Direct the hosts to open with today's specific development, then pull back to historical context
3. Ask them to probe the economic angle (who profits, who loses, what the market implications are)
4. Ask them to probe the legal/regulatory angle if relevant
5. Ask them to surface genuine disagreements and opposing legitimate perspectives — not strawmen
6. Specify the tone: sharp, no hand-holding, assume an educated listener (LLB, BA Econ & Philosophy)
7. End with: what should the listener watch for in the next 30 days

Write only the prompt text itself, nothing else. 180–250 words. Make it specific to this story — not generic.`, 1200);

  res.json({ prompt: promptText, sources });
});

app.post('/feedback', (req, res) => {
  const { id, headline, vote } = req.body;
  const p = join(__dir, 'feedback.json');
  let fb = { votes: {} };
  if (existsSync(p)) { try { fb = JSON.parse(readFileSync(p, 'utf8')); } catch {} }
  const topic = headline ?? id;
  fb.votes[topic] = (fb.votes[topic] ?? 0) + (vote === 1 ? 1 : vote === -1 ? -1 : 0);
  if (fb.votes[topic] === 0) delete fb.votes[topic];
  writeFileSync(p, JSON.stringify(fb, null, 2), 'utf8');
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/morning-paper.html`);
});
