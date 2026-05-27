const REPO = process.env.GITHUB_REPO || 'nzgorlin-lab/morning-paper';

async function getFeedback(token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/feedback.json`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'morning-paper',
    },
  });
  if (r.status === 404) return { votes: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  const data = await r.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { ...content, sha: data.sha };
}

async function saveFeedback(votes, sha, token) {
  const content = Buffer.from(JSON.stringify({ votes }, null, 2)).toString('base64');
  const body = {
    message: 'update feedback',
    content,
    committer: { name: 'Morning Paper Bot', email: 'bot@morning-paper.local' },
  };
  if (sha) body.sha = sha;

  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/feedback.json`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'morning-paper',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`GitHub PUT failed: ${r.status} — ${err}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, headline, vote } = req.body;
  const token = process.env.GH_PAT;

  if (!token) {
    // No GitHub token configured — acknowledge vote but don't persist
    console.log(`Vote received (not persisted — GH_PAT not set): ${headline} ${vote > 0 ? '👍' : '👎'}`);
    return res.json({ ok: true, persisted: false });
  }

  try {
    const fb = await getFeedback(token);
    const topic = headline ?? id;
    const delta = vote === 1 ? 1 : vote === -1 ? -1 : 0;
    fb.votes[topic] = (fb.votes[topic] ?? 0) + delta;
    if (fb.votes[topic] === 0) delete fb.votes[topic];
    await saveFeedback(fb.votes, fb.sha, token);
    res.json({ ok: true, persisted: true });
  } catch (e) {
    console.error('/feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
