import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const phone = process.env.CALLMEBOT_PHONE;
const key   = process.env.CALLMEBOT_APIKEY;
const url   = process.env.PAPER_URL;

if (!phone || !key || !url) {
  console.log('WhatsApp not configured (CALLMEBOT_PHONE / CALLMEBOT_APIKEY / PAPER_URL missing) — skipping');
  process.exit(0);
}

let meta;
try {
  meta = JSON.parse(readFileSync(join(__dir, 'paper-meta.json'), 'utf8'));
} catch {
  console.warn('paper-meta.json not found — skipping WhatsApp');
  process.exit(0);
}

const headlines = (meta.headlines ?? [])
  .slice(0, 6)
  .map(h => `• ${h.length > 85 ? h.slice(0, 82) + '…' : h}`)
  .join('\n');

const msg = `🗞️ Morning Paper — ${meta.date}\n\n${headlines}\n\n📖 ${url}/morning-paper.html`;

try {
  const r = await fetch(
    `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(msg)}&apikey=${key}`
  );
  const body = await r.text();
  console.log(`WhatsApp sent: ${r.status} — ${body.slice(0, 80)}`);
} catch (e) {
  console.warn('WhatsApp notification failed:', e.message);
}
