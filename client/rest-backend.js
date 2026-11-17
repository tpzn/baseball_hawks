/* index.html の <script> に貼り込むアダプタ（Cloudflare Workers REST 用）。 */
function restFail(code, message){ return {code, message: message || code}; }
async function restFetch(path, opts){
  let r;
  try { r = await fetch(path, Object.assign({credentials: 'same-origin', cache: 'no-store'}, opts)); }
  catch { throw restFail('store_unavailable', 'network error'); }
  if (r.status === 401) { location.reload(); throw restFail('not_granted', 'unauthorized'); }
  if (!r.ok) {
    let b = null; try { b = await r.json(); } catch {}
    const map = {413: 'too_large', 415: 'unsupported_type', 400: 'invalid_argument', 409: 'quota_or_state', 429: 'rate_limited'};
    throw restFail((b && b.code) || map[r.status] || (r.status >= 500 ? 'store_unavailable' : 'upstream_error'), (b && b.message) || ('HTTP ' + r.status));
  }
  return r.json();
}
function restBackend(){
  const subs = {};            // col -> [{cb, err}]
  let timer = null, fetching = false, started = false;
  const enc = s => encodeURIComponent(s);
  const split = p => { const i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
  async function poll(){
    if (fetching) return;
    fetching = true;
    try {
      const all = await restFetch('/api/all');
      for (const col of Object.keys(subs)) {
        const m = all[col] || {};
        const docs = Object.entries(m).map(([id, d]) => ({id, exists: true, data: () => d}));
        for (const s of subs[col]) s.cb(docs);
      }
    } catch (e) {
      for (const col of Object.keys(subs)) for (const s of subs[col]) if (s.err) s.err(e);
    } finally { fetching = false; }
  }
  function start(){
    if (started) return; started = true;
    timer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  }
  return {
    set: async (path, data) => { const [c, id] = split(path); await restFetch('/api/' + enc(c) + '/' + enc(id), {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}); },
    del: async path => { const [c, id] = split(path); await restFetch('/api/' + enc(c) + '/' + enc(id), {method: 'DELETE'}); },
    sub: (col, cb, err) => {
      (subs[col] = subs[col] || []).push({cb, err});
      start();
      // 同一ティックで複数 col を購読しても 1 回の取得にまとめる
      clearTimeout(restBackend._t); restBackend._t = setTimeout(poll, 0);
      return () => { subs[col] = subs[col].filter(s => s.cb !== cb); };
    }
  };
}
function restAssets(){
  return {
    upload: async (blob, opts) => {
      const type = (opts && opts.type) || blob.type || 'application/octet-stream';
      return restFetch('/api/blob', {method: 'POST', headers: {'content-type': type}, body: blob});
    },
    list: () => restFetch('/api/blob'),
    delete: id => restFetch('/api/blob/' + encodeURIComponent(id), {method: 'DELETE'})
  };
}
