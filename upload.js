// رفع ملفات المشروع إلى GitHub عبر API (بدون git)
const fs = require('fs');
const path = require('path');
// التوكن يُقرأ من .env (GITHUB_TOKEN=...) — لا تكتبه داخل الكود
require('dotenv').config();
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('ضع GITHUB_TOKEN في ملف .env'); process.exit(1); }
const REPO = 'hamzarajeh168-boop/group-passenger-commission';
const ROOT = __dirname;
const SKIP_DIRS = new Set(['node_modules', '.git', 'auth_info', '.aicode', '.vscode', 'data']);
const SKIP_FILES = new Set(['cloudflared.exe', 'get-gh.js', 'shahm-run.out.log', 'shahm-run.err.log', 'shahm-server.out.log', 'shahm-server.err.log', 'shahm-tunnel.out.log', 'shahm-tunnel.err.log', 'tunnel-out.log', 'cloudflared.out.log', 'cloudflared.err.log', 'server.js.bak', '.env']);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (SKIP_DIRS.has(f.name)) continue;
      walk(full, out);
    } else {
      if (SKIP_FILES.has(f.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).map(f => ({ p: path.relative(ROOT, f).replace(/\\/g, '/'), full: f }));
console.log('عدد الملفات:', files.length);

async function put(file, message, content) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(file)}`;
  const headers = { 'User-Agent': 'shahm-deploy', 'Authorization': `token ${TOKEN}`, 'Content-Type': 'application/json' };
  // نجلب sha للملف الموجود كي نستطيع تحديثه (بدون sha يفشل التحديث)
  let sha;
  const g = await fetch(url, { headers });
  if (g.ok) sha = (await g.json()).sha;
  const res = await fetch(url, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), sha })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${file}: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.status;
}

(async () => {
  for (const f of files) {
    const content = fs.readFileSync(f.full);
    if (content.length > 50 * 1024 * 1024) { console.log('SKIP كبير:', f.p); continue; }
    await put(f.p, `update ${f.p}`, content);
    console.log('تم', f.p);
  }
  console.log('اكتمل الرفع ✔');
})().catch(e => { console.error('خطأ:', e.message); process.exit(1); });
