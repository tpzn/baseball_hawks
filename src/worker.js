// Cloudflare Worker: Basic 認証 + D1 (docs) + R2 (動画) + 静的アセット委譲
// 依存なし。純粋関数は export してテスト可能。

export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_BLOB_BYTES = 60 * 1024 * 1024;
export const MAX_FILES = 10000;
export const MAX_TOTAL_BYTES = 9 * 1024 * 1024 * 1024;
export const ALLOWED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png'];

const NAME_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const BLOB_ID_RE = /^[0-9a-f]{32}$/;

export function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && s !== '.' && s !== '..';
}

export function validBlobId(s) {
  return typeof s === 'string' && BLOB_ID_RE.test(s);
}

// "Basic base64(user:pass)" -> {user, pass} | null
export function parseBasic(header) {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!m) return null;
  let bin;
  try { bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  let text;
  try {
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
  const i = text.indexOf(':');
  if (i < 0) return null;
  return { user: text.slice(0, i), pass: text.slice(i + 1) };
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// SHA-256 で長さを揃えてから XOR 比較（定数時間）
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export async function checkAuth(header, user, pass) {
  if (!user || !pass) return false;
  const c = parseBasic(header);
  if (!c) return false;
  const ok1 = await safeEqual(c.user, user);
  const ok2 = await safeEqual(c.pass, pass);
  return ok1 && ok2;
}

// Range ヘッダ解析。戻り値: null (Range なし/無視) | 'unsatisfiable' | {start, end} (end は含む)
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // 複数レンジ等は無視して全体を返す
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (size <= 0) return 'unsatisfiable';
  let start, end;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size) return 'unsatisfiable';
    if (end < start) return null;
  }
  return { start, end };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function err(status, code, message) {
  return json({ code, message }, status);
}

function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="baseball", charset="UTF-8"', 'cache-control': 'no-store' },
  });
}

async function readLimitedText(request, limit) {
  const cl = request.headers.get('content-length');
  if (cl && Number(cl) > limit) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > limit) return null;
  return new TextDecoder().decode(buf);
}

async function allDocs(env, col) {
  const rs = col
    ? await env.DB.prepare('SELECT col, id, data FROM docs WHERE col = ?').bind(col).all()
    : await env.DB.prepare('SELECT col, id, data FROM docs').all();
  const out = {};
  for (const r of rs.results || []) {
    let v;
    try { v = JSON.parse(r.data); } catch { continue; }
    if (col) out[r.id] = v;
    else (out[r.col] = out[r.col] || {})[r.id] = v;
  }
  return out;
}

async function handleApi(request, env, url, parts) {
  const method = request.method;
  // parts: ['api', ...]
  if (parts[1] === 'blob') return handleBlobApi(request, env, parts, method);

  if (parts[1] === 'all' && parts.length === 2) {
    if (method !== 'GET') return err(405, 'invalid_argument', 'method not allowed');
    return json(await allDocs(env, null));
  }
  const col = parts[1];
  if (!validName(col)) return err(400, 'invalid_argument', 'invalid collection');
  if (parts.length === 2) {
    if (method !== 'GET') return err(405, 'invalid_argument', 'method not allowed');
    return json(await allDocs(env, col));
  }
  if (parts.length === 3) {
    const id = parts[2];
    if (!validName(id)) return err(400, 'invalid_argument', 'invalid id');
    if (method === 'PUT') {
      const text = await readLimitedText(request, MAX_DOC_BYTES);
      if (text === null) return err(413, 'too_large', 'body too large');
      let obj;
      try { obj = JSON.parse(text); } catch { return err(400, 'invalid_argument', 'invalid JSON'); }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return err(400, 'invalid_argument', 'object required');
      const updated = Date.now();
      await env.DB.prepare(
        'INSERT INTO docs(col, id, data, updated) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated'
      ).bind(col, id, JSON.stringify(obj), updated).run();
      return json({ ok: true, updated });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM docs WHERE col = ? AND id = ?').bind(col, id).run();
      return json({ ok: true });
    }
    if (method === 'GET') {
      const r = await env.DB.prepare('SELECT data FROM docs WHERE col = ? AND id = ?').bind(col, id).first();
      if (!r) return err(404, 'invalid_argument', 'not found');
      return json(JSON.parse(r.data));
    }
    return err(405, 'invalid_argument', 'method not allowed');
  }
  return err(404, 'invalid_argument', 'not found');
}

async function handleBlobApi(request, env, parts, method) {
  if (parts.length === 2) {
    if (method === 'GET') {
      const rs = await env.DB.prepare('SELECT id, type, size, created FROM blobs ORDER BY created DESC').all();
      const list = (rs.results || []).map(r => ({
        id: r.id, url: '/_blob/' + r.id, contentType: r.type, sizeBytes: r.size, createdAt: r.created,
      }));
      const bytes = list.reduce((s, a) => s + (a.sizeBytes || 0), 0);
      return json({ assets: list, usage: { files: list.length, bytes, maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES } });
    }
    if (method === 'POST') {
      const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.includes(type)) return err(415, 'unsupported_type', 'unsupported content type');
      const cl = request.headers.get('content-length');
      if (cl && Number(cl) > MAX_BLOB_BYTES) return err(413, 'too_large', 'file too large');
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BLOB_BYTES) return err(413, 'too_large', 'file too large');
      if (buf.byteLength === 0) return err(400, 'invalid_argument', 'empty body');
      const st = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM blobs').first();
      if (st && (st.n >= MAX_FILES || st.b + buf.byteLength > MAX_TOTAL_BYTES)) return err(409, 'quota_or_state', 'storage quota exceeded');
      const id = crypto.randomUUID().replace(/-/g, '');
      await env.VIDEOS.put(id, buf, { httpMetadata: { contentType: type } });
      try {
        await env.DB.prepare('INSERT INTO blobs(id, type, size, created) VALUES(?,?,?,?)')
          .bind(id, type, buf.byteLength, Date.now()).run();
      } catch (e) {
        await env.VIDEOS.delete(id).catch(() => {});
        throw e;
      }
      return json({ id, url: '/_blob/' + id, sizeBytes: buf.byteLength, contentType: type });
    }
    return err(405, 'invalid_argument', 'method not allowed');
  }
  if (parts.length === 3 && method === 'DELETE') {
    const id = parts[2];
    if (!validBlobId(id)) return err(400, 'invalid_argument', 'invalid id');
    await env.VIDEOS.delete(id);
    await env.DB.prepare('DELETE FROM blobs WHERE id = ?').bind(id).run();
    return json({ deleted: true });
  }
  return err(404, 'invalid_argument', 'not found');
}

async function serveBlob(request, env, id) {
  if (!validBlobId(id)) return new Response('Not Found', { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const head = await env.VIDEOS.head(id);
  if (!head) return new Response('Not Found', { status: 404 });
  const size = head.size;
  const headers = new Headers();
  headers.set('content-type', (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream');
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  if (head.httpEtag) headers.set('etag', head.httpEtag);
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const length = range.end - range.start + 1;
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('content-length', String(length));
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
    const obj = await env.VIDEOS.get(id, { range: { offset: range.start, length } });
    if (!obj) return new Response('Not Found', { status: 404 });
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const obj = await env.VIDEOS.get(id);
  if (!obj) return new Response('Not Found', { status: 404 });
  return new Response(obj.body, { status: 200, headers });
}

export async function handle(request, env) {
  if (!env.BASIC_USER || !env.BASIC_PASS) {
    return err(500, 'store_unavailable', 'BASIC_USER / BASIC_PASS are not configured');
  }
  if (!(await checkAuth(request.headers.get('authorization'), env.BASIC_USER, env.BASIC_PASS))) {
    return unauthorized();
  }
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  try {
    if (parts[0] === 'api') return await handleApi(request, env, url, parts);
    if (parts[0] === '_blob' && parts.length === 2) return await serveBlob(request, env, parts[1]);
  } catch (e) {
    console.error(e && e.stack || e);
    return err(500, 'store_unavailable', 'internal error');
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
