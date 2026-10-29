// khuranahomescape reviews backend (Cloudflare Worker).
// Storage is behind the small `store` object so a database (e.g. Supabase) can replace KV later.
// Moderation: each submission emails the moderator inbox (via MAIL_WEBHOOK) with approve/reject links.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_TEXT = 4000;
const MAX_FILES = 4, MAX_IMG = 5 * 1024 * 1024, MAX_VID = 20 * 1024 * 1024;
function sniff(b) {
  const u = new Uint8Array(b.slice(0, 16));
  const s = (o, t) => [...t].every((c, i) => u[o + i] === c.charCodeAt(0));
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  if (u[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (s(0, 'GIF8')) return 'image/gif';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (s(4, 'ftyp')) return 'video/mp4';
  if (u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3) return 'video/webm';
  return null;
}

const store = {
  async addPending(env, review) { await env.REVIEWS.put('p:' + review.id, JSON.stringify(review)); },
  async getPending(env, id) { const v = await env.REVIEWS.get('p:' + id); return v ? JSON.parse(v) : null; },
  async deletePending(env, id) {
    const r = await this.getPending(env, id);
    if (r) for (const m of r.media || []) await env.REVIEWS.delete('m:' + id + ':' + m.n);
    await env.REVIEWS.delete('p:' + id);
  },
  async putMedia(env, id, n, buf, type) { await env.REVIEWS.put('m:' + id + ':' + n, buf, { metadata: { type } }); },
  async isApproved(env, id) { return (await env.REVIEWS.get('ar:' + id)) !== null; },
  async approve(env, review) {
    const pub = { id: review.id, name: review.name, area: review.area, year: review.year, rating: review.rating, text: review.text, date: review.date, media: review.media || [] };
    await env.REVIEWS.put('ar:' + review.id, '1');
    const key = 'a:' + String(9999999999999 - Date.now()).padStart(13, '0') + ':' + review.id;
    await env.REVIEWS.put(key, JSON.stringify(pub));
    await env.REVIEWS.delete('p:' + review.id);
  },
  async listApproved(env) {
    const l = await env.REVIEWS.list({ prefix: 'a:', limit: 200 });
    const items = await Promise.all(l.keys.map(k => env.REVIEWS.get(k.name)));
    return items.filter(Boolean).map(s => JSON.parse(s));
  },
};

const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: JSON_HEADERS });

async function notify(env, origin, review) {
  const sig = a => hmac(env.ADMIN_SECRET, review.id + ':' + a).then(s => s.slice(0, 40));
  const approve = `${origin}/m/${review.id}/approve/${await sig('approve')}`;
  const reject = `${origin}/m/${review.id}/reject/${await sig('reject')}`;
  const mlinks = [];
  for (const m of review.media || []) {
    const ms = (await hmac(env.ADMIN_SECRET, review.id + ':media:' + m.n)).slice(0, 40);
    mlinks.push(`<a href="${origin}/mm/${review.id}/${m.n}/${ms}">${m.type.startsWith('video') ? 'Video' : 'Image'} ${m.n + 1}</a>`);
  }
  const body = `<p>New review submitted on khuranahomescape (pending, NOT published).</p>
<p><b>Name shown:</b> ${esc(review.name || 'Anonymous')}<br><b>Area:</b> ${esc(review.area || '-')}<br><b>Year:</b> ${esc(review.year || '-')}<br><b>Rating:</b> ${esc(review.rating || '-')}<br><b>Contact (private, never published):</b> ${esc(review.contact || 'not given')}</p>
<blockquote style="border-left:3px solid #999;padding-left:10px;white-space:pre-wrap">${esc(review.text)}</blockquote>
<p><b>Attachments (private until approved):</b> ${mlinks.length ? mlinks.join(' | ') : 'none'}</p>
<p><a href="${approve}">APPROVE and publish</a> &nbsp;|&nbsp; <a href="${reject}">REJECT and delete</a></p>
<p>Check that the review is a genuine personal experience, factual in tone and free of abuse or private details before approving. Each link opens a confirmation page.</p>`;
  const r = await fetch(env.MAIL_WEBHOOK, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.MAIL_SECRET, to: env.MODERATOR_EMAIL, subject: 'khuranahomescape: new review awaiting approval', html: body }),
    redirect: 'follow',
  });
  return r.ok;
}

async function handleSubmit(request, env, origin) {
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > 62 * 1024 * 1024) return json({ error: 'Upload too large. Keep files within the limits.' }, 413);
  let fd;
  try { fd = await request.formData(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const g = k => { const v = fd.get(k); return typeof v === 'string' ? v : ''; };
  if (g('website')) return json({ ok: true }); // honeypot: pretend success
  if (g('ok') !== 'true') return json({ error: 'Please tick the confirmation box.' }, 400);
  const text = clean(g('text'), MAX_TEXT);
  if (text.length < 30) return json({ error: 'Please write a little more (at least 30 characters).' }, 400);
  const files = fd.getAll('media').filter(f => typeof f !== 'string' && f.size > 0);
  if (files.length > MAX_FILES) return json({ error: 'You can attach up to ' + MAX_FILES + ' files.' }, 400);
  const prepared = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const type = sniff(buf);
    if (!type) return json({ error: 'Only JPG, PNG, GIF, WebP images and MP4/WebM videos are accepted.' }, 400);
    if (type.startsWith('image') && buf.byteLength > MAX_IMG) return json({ error: 'Each image must be under 5 MB.' }, 400);
    if (type.startsWith('video') && buf.byteLength > MAX_VID) return json({ error: 'Each video must be under 20 MB.' }, 400);
    prepared.push({ buf, type });
  }
  // Short-lived, anonymous spam limit: salted hash of IP, never stored with the review, expires in an hour.
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  const day = new Date().toISOString().slice(0, 10);
  const rk = 'rl:' + (await hmac(env.ADMIN_SECRET, ip + day)).slice(0, 24);
  const n = parseInt((await env.REVIEWS.get(rk)) || '0', 10);
  if (n >= 5) return json({ error: 'Too many submissions from this connection. Please try again later.' }, 429);
  await env.REVIEWS.put(rk, String(n + 1), { expirationTtl: 3600 });
  const rating = ['1', '2', '3', '4', '5'].includes(g('rating')) ? g('rating') : '';
  const review = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
    name: clean(g('name'), 60), area: clean(g('area'), 100), year: clean(g('year'), 9), rating, text,
    contact: clean(g('contact'), 120), media: [],
    date: new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' }),
  };
  for (let i = 0; i < prepared.length; i++) {
    await store.putMedia(env, review.id, i, prepared[i].buf, prepared[i].type);
    review.media.push({ n: i, type: prepared[i].type });
  }
  await store.addPending(env, review);
  let sent = false;
  try { sent = await notify(env, origin, review); } catch (e) { sent = false; }
  return json({ ok: true, notified: sent });
}

async function serveMedia(request, env, id, n) {
  const r = await env.REVIEWS.getWithMetadata('m:' + id + ':' + n, 'arrayBuffer');
  if (!r.value) return new Response('Not found', { status: 404 });
  const type = (r.metadata && r.metadata.type) || 'application/octet-stream';
  const buf = r.value, total = buf.byteLength;
  const h = { 'content-type': type, 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600', 'content-security-policy': "default-src 'none'" };
  const m = (request.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let s = m[1] ? parseInt(m[1], 10) : total - parseInt(m[2], 10);
    let e = m[1] && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (s < 0) s = 0;
    if (s > e || s >= total) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + total } });
    return new Response(buf.slice(s, e + 1), { status: 206, headers: { ...h, 'content-range': `bytes ${s}-${e}/${total}`, 'content-length': String(e - s + 1) } });
  }
  return new Response(buf, { headers: { ...h, 'content-length': String(total) } });
}

function page(title, inner) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:17px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 18px">${inner}</body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

async function handleModerate(request, env, id, action, sig) {
  if (!['approve', 'reject'].includes(action)) return page('Not found', '<p>Not found.</p>');
  const good = (await hmac(env.ADMIN_SECRET, id + ':' + action)).slice(0, 40);
  if (!safeEq(good, sig)) return page('Invalid link', '<p>This link is not valid.</p>');
  const review = await store.getPending(env, id);
  if (!review) return page('Already handled', '<p>This review has already been approved or rejected (or does not exist).</p>');
  if (request.method === 'POST') {
    if (action === 'approve') { await store.approve(env, review); return page('Approved', '<h2>Approved</h2><p>The review is now live on the site.</p>'); }
    await store.deletePending(env, id);
    return page('Rejected', '<h2>Rejected</h2><p>The review was deleted and will not be published.</p>');
  }
  const att = (review.media || []).length ? '<p>Attachments (' + review.media.length + '):</p>' + (await Promise.all(review.media.map(async m => { const ms = (await hmac(env.ADMIN_SECRET, id + ':media:' + m.n)).slice(0, 40); const u = '/mm/' + id + '/' + m.n + '/' + ms; return m.type.startsWith('video') ? `<video src="${u}" controls preload="metadata" style="max-width:100%"></video>` : `<img src="${u}" style="max-width:100%">`; }))).join('') : '';
  const verb = action === 'approve' ? 'Approve and publish' : 'Reject and delete';
  return page(verb, `<h2>${verb}?</h2><blockquote style="white-space:pre-wrap;border-left:3px solid #999;padding-left:10px">${esc(review.text)}</blockquote><p>Shown as: ${esc(review.name || 'Anonymous')}</p>${att}<form method="POST"><button style="font-size:17px;padding:10px 20px">${verb}</button></form>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const p = url.pathname;
    if (p === '/api/reviews' && request.method === 'GET') {
      const reviews = await store.listApproved(env);
      return new Response(JSON.stringify({ reviews }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
    }
    if (p === '/api/submit' && request.method === 'POST') return handleSubmit(request, env, origin);
    const mm = p.match(/^\/mm\/([a-f0-9]{20})\/(\d)\/([a-f0-9]{40})$/);
    if (mm) {
      const good = (await hmac(env.ADMIN_SECRET, mm[1] + ':media:' + mm[2])).slice(0, 40);
      if (!safeEq(good, mm[3])) return new Response('Invalid link', { status: 403 });
      return serveMedia(request, env, mm[1], mm[2]);
    }
    const pm = p.match(/^\/media\/([a-f0-9]{20})\/(\d)$/);
    if (pm) {
      if (!(await store.isApproved(env, pm[1]))) return new Response('Not found', { status: 404 });
      return serveMedia(request, env, pm[1], pm[2]);
    }
    const m = p.match(/^\/m\/([a-f0-9]{20})\/(approve|reject)\/([a-f0-9]{40})$/);
    if (m) return handleModerate(request, env, m[1], m[2], m[3]);
    if (p === '/sitemap.xml') return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, { headers: { 'content-type': 'application/xml' } });
    return env.ASSETS.fetch(request);
  },
};
