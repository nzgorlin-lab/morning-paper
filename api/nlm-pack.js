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

async function callGroq(prompt, maxTokens = 1200) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.6,
    }),
  });
  const d = await r.json();
  return d.choices[0].message.content;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { headline, paragraphs } = req.body;
  const summary = paragraphs.join(' ');

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

  const seen = new Set();
  const sources = allSearches.flat()
    .filter(r => {
      if (seen.has(r.url) || !r.url || !r.title) return false;
      seen.add(r.url);
      return true;
    })
    .slice(0, 15)
    .map(r => ({ url: r.url, title: r.title, snippet: (r.content ?? '').slice(0, 130) }));

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

Write only the prompt text itself, nothing else. 180–250 words. Make it specific to this story — not generic.`);

  res.json({ prompt: promptText, sources });
}
