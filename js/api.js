import { CONFIG } from './config.js';
import { parseTs } from './ui.js';

export const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 10 } }
});

// Jam server (untuk menghitung kedaluwarsa pesan secara akurat walau jam perangkat meleset).
let clockOffset = 0;
export function setServerClock(iso) {
  const t = parseTs(iso);
  if (Number.isFinite(t)) clockOffset = t - Date.now();
}
export function serverNow() { return Date.now() + clockOffset; }

export function apiError(e) {
  const raw = (e && (e.message || e.error_description || e.msg)) || 'Kesalahan tidak dikenal';
  const err = new Error(raw);
  err.code = String(raw).split(':')[0].trim();
  err.detail = String(raw).includes(':') ? String(raw).split(':').slice(1).join(':').trim() : '';
  return err;
}

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw apiError(error);
  return data;
}

export function usernameToEmail(username) {
  return CONFIG.EMAIL_TEMPLATE.replace('{u}', username.trim().toLowerCase());
}

export function functionUrl(name) {
  return CONFIG.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/' + name;
}

export async function callFunction(name, body) {
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if (!session) throw new Error('NOT_AUTHENTICATED');
  const res = await fetch(functionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + session.access_token,
      apikey: CONFIG.SUPABASE_ANON_KEY
    },
    body: JSON.stringify(body || {})
  });
  let json = {};
  try { json = await res.json(); } catch { /* respons bukan JSON */ }
  if (!res.ok || !json.ok) throw new Error(json.error || ('HTTP_' + res.status));
  return json;
}

// Hapus sisa token sesi Supabase dari penyimpanan browser.
export function purgeAuthStorage() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* abaikan */ }
}
