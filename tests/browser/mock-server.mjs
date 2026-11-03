// Server tiruan untuk menguji klien di browser. Meniru SEMANTIK fungsi SQL/Edge Function (bukan implementasinya).
// Jalankan: node tests/browser/mock-server.mjs  (PORT default 8799)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8799);
const TIMEOUT = 120000;
const uuid = () => crypto.randomUUID();
const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();

const db = {
  users: [
    { id: uuid(), email: 'usera@twochat.invalid', password: 'passA-12345', username: 'usera', slot: 'A' },
    { id: uuid(), email: 'userb@twochat.invalid', password: 'passB-12345', username: 'userb', slot: 'B' }
  ],
  tokens: new Map(),      // token -> {uid, sid}
  devices: new Map(),     // uid -> {sid, last_seen}
  unlocks: new Map(),     // sid -> uid
  attempts: new Map(),    // uid -> {fail, locked_until}
  state: { initialized: false, epoch: 1, status: 'active', timer_seconds: null, kdf_salt: null, kdf_iters: null },
  secret: { verifier: null, wrapped: null, iv: null },
  messages: [],
  storage: new Map(),
  clients: new Set(),
  presence: new Map(),    // uid -> meta
  failStorage: false
};

const err = (code) => Object.assign(new Error(code), { code });
const ctxOf = (req) => {
  const h = req.headers.authorization || '';
  const tok = h.replace(/^Bearer\s+/i, '') || new URL(req.url, 'http://x').searchParams.get('token') || '';
  const c = db.tokens.get(tok);
  return c ? { ...c, token: tok } : null;
};
const isMember = (c) => c && db.users.some((u) => u.id === c.uid);
const isActive = (c) => { if (!isMember(c)) return false; const d = db.devices.get(c.uid); return !!d && d.sid === c.sid && now() - d.last_seen < TIMEOUT; };
const isUnlocked = (c) => isActive(c) && db.unlocks.get(c.sid) === c.uid;
const need = (ok, code) => { if (!ok) throw err(code); };
const visibleMsg = (m) => m.expires_at == null || Date.parse(m.expires_at) > now();

function canSee(c, evt) {
  if (evt.kind === 'presence' || evt.kind === 'room_state') return isActive(c);
  if (evt.kind === 'broadcast') return isActive(c) && c.uid !== evt.from;
  if (evt.kind === 'msg') {
    if (evt.type === 'DELETE') return isActive(c);
    return isUnlocked(c) && db.state.status === 'active' && visibleMsg(evt.row);
  }
  return false;
}
function emit(evt) {
  for (const cl of db.clients) {
    if (!canSee(cl.ctx, evt)) continue;
    let payload;
    if (evt.kind === 'msg') payload = { t: 'pg', table: 'messages', eventType: evt.type, new: evt.type === 'DELETE' ? {} : evt.row, old: evt.type === 'DELETE' ? { id: evt.row.id } : {} };
    else if (evt.kind === 'room_state') payload = { t: 'pg', table: 'room_state', eventType: 'UPDATE', new: pubState(), old: {} };
    else if (evt.kind === 'presence') payload = { t: 'presence', state: presenceState() };
    else payload = { t: 'broadcast', event: evt.event, payload: evt.payload };
    cl.res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }
}
const presenceState = () => Object.fromEntries([...db.presence].map(([k, v]) => [k, [v]]));
const pubState = () => ({ id: 1, ...db.state });

const rpc = {
  claim_session(c) {
    need(c, 'NOT_AUTHENTICATED'); need(isMember(c), 'NOT_MEMBER');
    const cur = db.devices.get(c.uid);
    if (cur) {
      if (cur.sid === c.sid) cur.last_seen = now();
      else if (now() - cur.last_seen < TIMEOUT) throw err('SESSION_ACTIVE');
      else { db.devices.set(c.uid, { sid: c.sid, last_seen: now() }); dropUnlocks(c.uid); }
    } else { db.devices.set(c.uid, { sid: c.sid, last_seen: now() }); dropUnlocks(c.uid); }
    return { ok: true, now: iso(now()) };
  },
  heartbeat(c) {
    need(c, 'NOT_AUTHENTICATED');
    const d = db.devices.get(c.uid);
    if (!d || d.sid !== c.sid) throw err('SESSION_REPLACED');
    d.last_seen = now();
    return { ok: true, now: iso(now()) };
  },
  release_session(c) { need(c, 'NOT_AUTHENTICATED'); db.unlocks.delete(c.sid); const d = db.devices.get(c.uid); if (d && d.sid === c.sid) db.devices.delete(c.uid); return { ok: true }; },
  setup_room(c, a) {
    need(isActive(c), 'NOT_ACTIVE'); need(!db.state.initialized, 'ALREADY_INITIALIZED');
    need(a.p_iters >= 200000 || process.env.RELAX_ITERS === '1', 'BAD_PARAMS');
    need(/^[0-9a-f]{64}$/.test(a.p_verifier) && a.p_salt.length >= 20 && a.p_salt.length <= 64 && a.p_wrapped.length >= 60 && a.p_wrapped.length <= 100 && a.p_wrapped_iv.length === 16, 'BAD_PARAMS');
    Object.assign(db.state, { initialized: true, kdf_salt: a.p_salt, kdf_iters: a.p_iters });
    Object.assign(db.secret, { verifier: a.p_verifier, wrapped: a.p_wrapped, iv: a.p_wrapped_iv });
    db.unlocks.set(c.sid, c.uid);
    emit({ kind: 'room_state' });
    return { ok: true };
  },
  unlock_room(c, a) {
    need(isActive(c), 'NOT_ACTIVE'); need(db.state.initialized, 'NOT_INITIALIZED'); need(/^[0-9a-f]{64}$/.test(a.p_token), 'BAD_PARAMS');
    const at = db.attempts.get(c.uid) || { fail: 0, locked_until: 0 };
    db.attempts.set(c.uid, at);
    if (at.locked_until > now()) return { ok: false, locked: true, retry_after: Math.ceil((at.locked_until - now()) / 1000) };
    const ver = crypto.createHash('sha256').update(Buffer.from(a.p_token, 'hex')).digest('hex');
    if (ver === db.secret.verifier) { at.fail = 0; at.locked_until = 0; db.unlocks.set(c.sid, c.uid); return { ok: true }; }
    at.fail += 1;
    if (at.fail >= 5) { at.fail = 0; at.locked_until = now() + 300000; }
    return { ok: false };
  },
  get_wrapped_key(c) {
    need(isUnlocked(c), 'NOT_UNLOCKED'); need(db.state.status === 'active', 'RESETTING');
    return { wrapped: db.secret.wrapped, iv: db.secret.iv, epoch: db.state.epoch };
  },
  set_timer(c, a) {
    need(isUnlocked(c), 'NOT_UNLOCKED'); need([0, 30, 60, 300, 3600, 86400, 604800].includes(a.p_seconds), 'BAD_PARAMS'); need(db.state.status === 'active', 'RESETTING');
    db.state.timer_seconds = a.p_seconds === 0 ? null : a.p_seconds;
    emit({ kind: 'room_state' });
    return { ok: true };
  },
  send_message(c, a) {
    need(isUnlocked(c), 'NOT_UNLOCKED'); need(db.state.status === 'active', 'RESETTING'); need(db.state.epoch === a.p_epoch, 'EPOCH_MISMATCH');
    need(a.p_attachment == null || /^files\/[0-9a-f-]{36}\.bin$/.test(a.p_attachment), 'BAD_PARAMS');
    need(!db.messages.some((m) => m.id === a.p_id), 'DUPLICATE');
    const t = now();
    const row = { id: a.p_id, epoch: db.state.epoch, sender_id: c.uid, ciphertext: a.p_ciphertext, iv: a.p_iv, attachment_path: a.p_attachment, created_at: iso(t), expires_at: db.state.timer_seconds == null ? null : iso(t + db.state.timer_seconds * 1000), delivered_at: null, read_at: null };
    db.messages.push(row);
    emit({ kind: 'msg', type: 'INSERT', row });
    return row;
  },
  mark_delivered(c, a) {
    need(isUnlocked(c), 'NOT_UNLOCKED');
    for (const m of db.messages) if (a.p_ids.includes(m.id) && m.sender_id !== c.uid && !m.delivered_at) { m.delivered_at = iso(now()); emit({ kind: 'msg', type: 'UPDATE', row: m }); }
    return null;
  },
  mark_read(c, a) {
    need(isUnlocked(c), 'NOT_UNLOCKED');
    for (const m of db.messages) if (a.p_ids.includes(m.id) && m.sender_id !== c.uid && !m.read_at) { m.read_at = iso(now()); m.delivered_at = m.delivered_at || m.read_at; emit({ kind: 'msg', type: 'UPDATE', row: m }); }
    return null;
  }
};
function dropUnlocks(uid) { for (const [sid, u] of db.unlocks) if (u === uid) db.unlocks.delete(sid); }

function wipeMessages() {
  const old = db.messages.splice(0);
  for (const m of old) emit({ kind: 'msg', type: 'DELETE', row: m });
}

function resetRoom(c, body) {
  need(isUnlocked(c), 'NOT_UNLOCKED');
  if (db.state.status !== 'resetting') { db.state.status = 'resetting'; emit({ kind: 'room_state' }); }
  if (db.failStorage) throw err('STORAGE_FAILED');
  db.storage.clear();
  if (db.state.status === 'resetting') {
    wipeMessages();
    if (db.state.initialized) { db.secret.wrapped = body.wrapped; db.secret.iv = body.iv; }
    db.state.status = 'active'; db.state.epoch += 1;
    if (body.logout !== false) { dropUnlocks(c.uid); db.devices.delete(c.uid); }
    emit({ kind: 'room_state' });
  }
  if (body.logout !== false) for (const [t, v] of db.tokens) if (v.uid === c.uid) db.tokens.delete(t);
}

setInterval(() => {
  const t = now();
  for (const m of [...db.messages]) {
    if (m.expires_at != null && Date.parse(m.expires_at) <= t) {
      db.messages.splice(db.messages.indexOf(m), 1);
      if (m.attachment_path) db.storage.delete(m.attachment_path);
      emit({ kind: 'msg', type: 'DELETE', row: m });
    }
  }
}, 500);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain' };
const readBody = (req) => new Promise((res) => { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => res(Buffer.concat(ch))); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/events') {
      const c = ctxOf(req);
      if (!c) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      const cl = { res, ctx: c };
      db.clients.add(cl);
      req.on('close', () => { db.clients.delete(cl); if (db.presence.delete(c.uid)) emit({ kind: 'presence' }); });
      return;
    }
    if (p === '/api/auth/login') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const u = db.users.find((x) => x.email === b.email && x.password === b.password);
      if (!u) return send(res, 400, { message: 'Invalid login credentials' });
      const tok = 'tok_' + uuid(); const sid = uuid();
      db.tokens.set(tok, { uid: u.id, sid });
      return send(res, 200, { access_token: tok, user: { id: u.id } });
    }
    if (p === '/api/auth/logout') {
      const c = ctxOf(req); if (c) db.tokens.delete(c.token);
      return send(res, 200, {});
    }
    if (p.startsWith('/api/rpc/')) {
      const name = p.slice('/api/rpc/'.length);
      const c = ctxOf(req);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!rpc[name]) return send(res, 404, { message: 'no such function' });
      try { return send(res, 200, { data: rpc[name](c, body) }); } catch (e) { return send(res, 400, { message: e.code || e.message }); }
    }
    if (p.startsWith('/api/table/')) {
      const c = ctxOf(req); const t = p.slice('/api/table/'.length);
      let rows = [];
      if (t === 'room_members' && isActive(c)) rows = db.users.map((u) => ({ user_id: u.id, username: u.username, slot: u.slot }));
      if (t === 'room_state' && isActive(c)) rows = [pubState()];
      if (t === 'messages' && isUnlocked(c) && db.state.status === 'active') rows = db.messages.filter(visibleMsg);
      return send(res, 200, { data: rows });
    }
    if (p.startsWith('/api/storage/')) {
      const c = ctxOf(req); const key = decodeURIComponent(p.slice('/api/storage/'.length));
      if (req.method === 'PUT') {
        if (!isUnlocked(c) || !/^files\/[0-9a-f-]{36}\.bin$/.test(key)) return send(res, 403, { message: 'denied' });
        db.storage.set(key, await readBody(req)); return send(res, 200, {});
      }
      if (!isUnlocked(c) || !db.storage.has(key)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(db.storage.get(key)); return;
    }
    if (p === '/api/presence') {
      const c = ctxOf(req); const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (isActive(c)) { db.presence.set(c.uid, b.meta || {}); emit({ kind: 'presence' }); }
      return send(res, 200, {});
    }
    if (p === '/api/broadcast') {
      const c = ctxOf(req); const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (isActive(c)) emit({ kind: 'broadcast', from: c.uid, event: b.event, payload: b.payload });
      return send(res, 200, {});
    }
    if (p === '/functions/v1/reset-room' && req.method === 'POST') {
      const c = ctxOf(req); const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (!c) return send(res, 401, { ok: false, error: 'BAD_TOKEN' });
      try { resetRoom(c, b); return send(res, 200, { ok: true }); } catch (e) { return send(res, 500, { ok: false, error: e.code || 'INTERNAL' }); }
    }
    if (p === '/functions/v1/cleanup') return send(res, 200, { ok: true });

    // ---- endpoint uji ----
    if (p === '/test/dump') {
      return send(res, 200, { state: pubState(), secret: db.secret, messages: db.messages, storage: [...db.storage].map(([k, v]) => ({ path: k, head: v.subarray(0, 4).toString('hex'), size: v.length })) });
    }
    if (p.startsWith('/test/stale/')) { const u = db.users.find((x) => x.username === p.split('/').pop()); const d = db.devices.get(u.id); if (d) d.last_seen = 0; return send(res, 200, {}); }
    if (p.startsWith('/test/failstorage/')) { db.failStorage = p.endsWith('/1'); return send(res, 200, {}); }

    // ---- statis ----
    let file = p === '/' ? '/index.html' : p;
    if (file === '/js/config.js') {
      let s = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
      s = s.replace('https://GANTI-DENGAN-PROJECT-REF.supabase.co', 'http://127.0.0.1:' + PORT)
           .replace('HEARTBEAT_MS: 20000', 'HEARTBEAT_MS: 1000').replace('POLL_MS: 5000', 'POLL_MS: 1000').replace('KDF_ITERATIONS: 600000', 'KDF_ITERATIONS: 200000');
      res.writeHead(200, { 'Content-Type': MIME['.js'] }); res.end(s); return;
    }
    if (file === '/vendor/supabase.js') file = '/tests/browser/mock-supabase-client.js';
    const full = path.normalize(path.join(ROOT, file));
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(full));
  } catch (e) {
    send(res, 500, { message: 'mock error ' + e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log('mock server on ' + PORT));
