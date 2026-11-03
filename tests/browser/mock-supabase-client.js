// Pengganti supabase-js untuk pengujian: hanya API yang dipakai aplikasi.
(function () {
  const KEY = 'sb-mock-auth-token';
  const BASE = location.origin + '/api';
  const getStored = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const hdr = () => { const s = getStored(); return s ? { Authorization: 'Bearer ' + s.access_token } : {}; };
  const post = async (path, body) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr()), body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  function createClient() {
    const authCbs = [];
    const fire = (evt, session) => authCbs.forEach((cb) => { try { cb(evt, session); } catch (e) { console.error(e); } });
    const auth = {
      async signInWithPassword({ email, password }) {
        const r = await post('/auth/login', { email, password });
        if (r.status !== 200) return { data: { session: null }, error: { message: r.json.message || 'Invalid login credentials' } };
        const session = { access_token: r.json.access_token, user: r.json.user };
        localStorage.setItem(KEY, JSON.stringify(session));
        fire('SIGNED_IN', session);
        return { data: { session, user: session.user }, error: null };
      },
      async getSession() { return { data: { session: getStored() }, error: null }; },
      async signOut() {
        await post('/auth/logout', {});
        localStorage.removeItem(KEY);
        fire('SIGNED_OUT', null);
        return { error: null };
      },
      onAuthStateChange(cb) { authCbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; }
    };

    async function rpc(name, args) {
      const r = await post('/rpc/' + name, args);
      if (r.status !== 200) return { data: null, error: { message: r.json.message || 'error' } };
      return { data: r.json.data, error: null };
    }

    function from(table) {
      const q = { eq: [], order: null, limit: null, single: null };
      const api = {
        select() { return api; },
        order(c, o) { q.order = [c, o]; return api; },
        limit(n) { q.limit = n; return api; },
        eq(c, v) { q.eq.push([c, v]); return api; },
        single() { q.single = 'single'; return api; },
        maybeSingle() { q.single = 'maybe'; return api; },
        then(ok, bad) { return run().then(ok, bad); }
      };
      async function run() {
        const r = await fetch(BASE + '/table/' + table, { headers: hdr() });
        let rows = (await r.json()).data || [];
        for (const [c, v] of q.eq) rows = rows.filter((x) => x[c] === v);
        if (q.order) rows = rows.slice().sort((a, b) => (a[q.order[0]] > b[q.order[0]] ? 1 : -1) * (q.order[1] && q.order[1].ascending === false ? -1 : 1));
        if (q.limit) rows = rows.slice(0, q.limit);
        if (q.single === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        if (q.single === 'maybe') return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }
      return api;
    }

    const storage = {
      from() {
        return {
          async upload(path, blob) {
            const r = await fetch(BASE + '/storage/' + encodeURIComponent(path), { method: 'PUT', headers: hdr(), body: blob });
            return r.ok ? { data: { path }, error: null } : { data: null, error: { message: 'denied' } };
          },
          async download(path) {
            const r = await fetch(BASE + '/storage/' + encodeURIComponent(path), { headers: hdr() });
            return r.ok ? { data: await r.blob(), error: null } : { data: null, error: { message: 'not found' } };
          }
        };
      }
    };

    const channels = new Set();
    function channel(name, cfg) {
      const handlers = { pg: [], presence: [], broadcast: [] };
      let es = null;
      const ch = {
        on(type, filter, cb) {
          if (type === 'postgres_changes') handlers.pg.push({ filter, cb });
          else if (type === 'presence') handlers.presence.push(cb);
          else if (type === 'broadcast') handlers.broadcast.push({ event: filter.event, cb });
          return ch;
        },
        subscribe(statusCb) {
          const s = getStored();
          es = new EventSource(BASE + '/events?token=' + encodeURIComponent(s ? s.access_token : ''));
          es.onopen = () => statusCb && statusCb('SUBSCRIBED');
          es.onerror = () => statusCb && statusCb('CHANNEL_ERROR');
          es.onmessage = (ev) => {
            const d = JSON.parse(ev.data);
            if (d.t === 'pg') handlers.pg.filter((h) => h.filter.table === d.table).forEach((h) => h.cb({ eventType: d.eventType, new: d.new, old: d.old }));
            else if (d.t === 'presence') { ch._presence = d.state; handlers.presence.forEach((cb) => cb()); }
            else if (d.t === 'broadcast') handlers.broadcast.filter((h) => h.event === d.event).forEach((h) => h.cb({ payload: d.payload }));
          };
          return ch;
        },
        async track(meta) { await post('/presence', { meta }); },
        async send(msg) { await post('/broadcast', { event: msg.event, payload: msg.payload }); },
        presenceState() { return ch._presence || {}; },
        _close() { if (es) es.close(); }
      };
      channels.add(ch);
      return ch;
    }

    return {
      auth, rpc, from, storage, channel,
      removeChannel(ch) { ch._close(); channels.delete(ch); }
    };
  }
  window.supabase = { createClient };
})();
