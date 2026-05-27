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
  const searchResults = await tavilySearch(headline, { days: 7 })
    .then(d => d.results ?? []).catch(() => []);

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
}
