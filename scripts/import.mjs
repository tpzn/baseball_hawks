// 使い方: node scripts/import.mjs <URL> <user> <pass> <export.json>
// JSON 形式: {players:{id:obj}, sessions:{...}, ...}
import { readFile } from 'node:fs/promises';

const [base, user, pass, file] = process.argv.slice(2);
if (!base || !user || !pass || !file) {
  console.error('usage: node scripts/import.mjs <URL> <user> <pass> <export.json>');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
const data = JSON.parse(await readFile(file, 'utf8'));
let ok = 0, ng = 0;
for (const [col, docs] of Object.entries(data)) {
  if (!docs || typeof docs !== 'object') continue;
  for (const [id, obj] of Object.entries(docs)) {
    const url = `${base.replace(/\/$/, '')}/api/${encodeURIComponent(col)}/${encodeURIComponent(id)}`;
    const r = await fetch(url, { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    if (r.ok) ok++; else { ng++; console.error(`NG ${col}/${id}: ${r.status} ${await r.text()}`); }
  }
}
console.log(`done: ${ok} ok, ${ng} failed`);
process.exit(ng ? 1 : 0);
