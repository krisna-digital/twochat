import { CONFIG } from './config.js';
import { sb, rpc, setServerClock, usernameToEmail, callFunction, purgeAuthStorage } from './api.js';
import * as C from './crypto.js';
import { $, show, toast, showError, setBusy } from './ui.js';
import { Chat } from './chat.js';

const ctx = {
  userId: null, username: null, peer: null,
  roomKey: null, kek: null, epoch: null, state: null,
  loggingOut: false, unlockMode: 'unlock'
};
let chat = null;
let hbTimer = null;
let hbBound = false;

const USERNAME_RE = /^[a-z0-9._-]{2,20}$/;

/* ---------- util ---------- */
function friendly(e) {
  switch (e && e.code) {
    case 'NOT_MEMBER': return 'Akun ini tidak diizinkan.';
    case 'SESSION_ACTIVE': return 'Akun ini sedang aktif di perangkat lain. Silakan logout dari perangkat sebelumnya untuk melanjutkan.';
    case 'LOCKED': return 'Terlalu banyak percobaan. Coba lagi dalam ' + Math.max(1, Math.ceil(Number(e.detail || 300) / 60)) + ' menit.';
    case 'RESETTING': return 'Room sedang direset. Coba lagi sebentar lagi.';
    default: return 'Terjadi kesalahan. Periksa koneksi lalu coba lagi.';
  }
}

function wipeMemory() {
  ctx.roomKey = null;
  ctx.kek = null;
  ctx.epoch = null;
  ctx.state = null;
  ctx.peer = null;
  ctx.username = null;
}

function stopHeartbeat() {
  clearInterval(hbTimer);
  hbTimer = null;
}

async function safeSignOut() {
  // PENTING: scope 'local' agar hanya sesi ini yang dicabut (bukan sesi perangkat lain).
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* sesi mungkin sudah dicabut server */ }
}

function showLogin(msg) {
  $('#login-pass').value = '';
  showError($('#login-err'), msg || '');
  show('login');
  setTimeout(() => $('#login-user').focus(), 50);
}

function showFatal(msg) {
  $('#fatal-msg').textContent = msg;
  show('fatal');
}

async function forceLocalLogout(msg) {
  if (chat) { chat.destroy(); chat = null; }
  stopHeartbeat();
  ctx.userId = null;
  wipeMemory();
  await safeSignOut();
  purgeAuthStorage();
  showLogin(msg);
}

function sessionLost() {
  forceLocalLogout('Sesi ini sudah tidak aktif (digantikan perangkat lain atau kedaluwarsa). Silakan login kembali.');
}

/* ---------- heartbeat sesi ---------- */
function startHeartbeat() {
  stopHeartbeat();
  const beat = async () => {
    try {
      const r = await rpc('heartbeat');
      if (r && r.now) setServerClock(r.now);
    } catch (e) {
      if (e.code === 'SESSION_REPLACED' || e.code === 'NOT_AUTHENTICATED') sessionLost();
      // kesalahan jaringan diabaikan: coba lagi pada detak berikutnya
    }
  };
  beat();
  hbTimer = setInterval(beat, CONFIG.HEARTBEAT_MS);
  if (!hbBound) {
    hbBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.userId && hbTimer) beat();
    });
  }
}

/* ---------- login ---------- */
function wireLogin() {
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-err');
    const btn = $('#login-btn');
    const username = $('#login-user').value.trim().toLowerCase();
    const password = $('#login-pass').value;
    showError(err, '');
    if (!USERNAME_RE.test(username) || !password) { showError(err, 'Username atau password salah.'); return; }
    setBusy(btn, true, 'Masuk…');
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
      if (error || !data || !data.session) {
        const net = error && /fetch|network|failed/i.test(error.message || '');
        showError(err, net ? 'Tidak dapat terhubung ke server.' : 'Username atau password salah.');
        return;
      }
      await afterAuth(data.session);
    } catch {
      showError(err, 'Tidak dapat terhubung ke server.');
    } finally {
      setBusy(btn, false);
    }
  });
}

async function afterAuth(session) {
  show('loading');
  ctx.userId = session.user.id;
  try {
    await rpc('claim_session');
  } catch (e) {
    ctx.userId = null;
    await safeSignOut();
    if (e.code === 'SESSION_ACTIVE' || e.code === 'NOT_MEMBER') { showLogin(friendly(e)); return; }
    showLogin('Tidak dapat memulai sesi. Periksa koneksi lalu coba lagi.');
    return;
  }
  startHeartbeat();
  try {
    const { data: members, error: me } = await sb.from('room_members').select('user_id, username');
    if (me || !members) throw new Error('MEMBERS');
    const mine = members.find((m) => m.user_id === ctx.userId);
    const other = members.find((m) => m.user_id !== ctx.userId);
    ctx.username = mine ? mine.username : 'saya';
    ctx.peer = other ? other.username : null;
    const { data: st, error: se } = await sb.from('room_state').select('*').eq('id', 1).single();
    if (se || !st) throw new Error('STATE');
    ctx.state = st;
    showUnlock(st.initialized ? 'unlock' : 'setup');
  } catch {
    showFatal('Gagal memuat data room. Periksa koneksi dan konfigurasi Supabase, lalu muat ulang.');
  }
}

/* ---------- password room ---------- */
function showUnlock(mode) {
  ctx.unlockMode = mode;
  $('#unlock-pw').value = '';
  $('#unlock-pw2').value = '';
  showError($('#unlock-err'), '');
  const setup = mode === 'setup';
  $('#unlock-pw2-wrap').hidden = !setup;
  $('#unlock-title').textContent = setup ? 'Buat password room' : 'Password room';
  $('#unlock-hint').textContent = setup
    ? 'Belum ada password room. Buat satu (minimal ' + CONFIG.MIN_ROOM_PASSWORD + ' karakter; disarankan frasa acak 6 kata) dan bagikan ke lawan bicara lewat jalur lain. Password ini tidak bisa dipulihkan.'
    : 'Masukkan password room untuk membuka chat. Password ini terpisah dari password login dan tidak pernah dikirim ke server.';
  $('#unlock-btn').textContent = setup ? 'Buat & buka room' : 'Buka room';
  show('unlock');
  setTimeout(() => $('#unlock-pw').focus(), 50);
}

function wireUnlock() {
  $('#form-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#unlock-err');
    const btn = $('#unlock-btn');
    const pw = $('#unlock-pw').value;
    showError(err, '');
    try {
      if (ctx.unlockMode === 'setup') {
        if (pw.length < CONFIG.MIN_ROOM_PASSWORD) { showError(err, 'Password room minimal ' + CONFIG.MIN_ROOM_PASSWORD + ' karakter.'); return; }
        if (pw !== $('#unlock-pw2').value) { showError(err, 'Konfirmasi password room tidak sama.'); return; }
        setBusy(btn, true, 'Memproses kunci…');
        await doSetup(pw);
      } else {
        if (!pw) { showError(err, 'Masukkan password room.'); return; }
        setBusy(btn, true, 'Memproses kunci…');
        const ok = await doUnlock(pw);
        if (!ok) { showError(err, 'Password room salah.'); $('#unlock-pw').select(); return; }
      }
      await enterChat();
    } catch (ex) {
      if (ex.code === 'NOT_INITIALIZED') return; // layar sudah dialihkan ke mode setup
      if (ex.code === 'NOT_ACTIVE' || ex.code === 'NOT_AUTHENTICATED') { sessionLost(); return; }
      if (ex.code === 'ALREADY_INITIALIZED') {
        const { data: st } = await sb.from('room_state').select('*').eq('id', 1).single();
        if (st) ctx.state = st;
        showUnlock('unlock');
        showError($('#unlock-err'), 'Room sudah dibuat oleh pengguna lain. Masukkan password room.');
        return;
      }
      showError(err, friendly(ex));
    } finally {
      setBusy(btn, false);
      btn.textContent = ctx.unlockMode === 'setup' ? 'Buat & buka room' : 'Buka room';
    }
  });

  $('#unlock-cancel').addEventListener('click', async () => {
    ctx.userId = null;
    stopHeartbeat();
    try { await rpc('release_session'); } catch { /* abaikan */ }
    wipeMemory();
    await safeSignOut();
    purgeAuthStorage();
    showLogin('');
  });
}

async function doSetup(pw) {
  const salt = C.newSalt();
  const iters = CONFIG.KDF_ITERATIONS;
  const { authToken, kek } = await C.deriveFromPassword(pw, salt, iters);
  const roomKey = await C.generateRoomKey();
  const w = await C.wrapRoomKey(kek, roomKey);
  const verifier = await C.verifierOf(authToken);
  await rpc('setup_room', { p_salt: salt, p_iters: iters, p_verifier: verifier, p_wrapped: w.wrapped, p_wrapped_iv: w.iv });
  const { data: st } = await sb.from('room_state').select('*').eq('id', 1).single();
  ctx.state = st;
  ctx.kek = kek;
  ctx.roomKey = await C.unwrapRoomKey(kek, w.wrapped, w.iv);
  ctx.epoch = st.epoch;
}

async function doUnlock(pw) {
  const { data: st } = await sb.from('room_state').select('*').eq('id', 1).single();
  if (st) ctx.state = st;
  if (!ctx.state || !ctx.state.initialized) { showUnlock('setup'); throw Object.assign(new Error('NOT_INITIALIZED'), { code: 'NOT_INITIALIZED' }); }
  const { authToken, kek } = await C.deriveFromPassword(pw, ctx.state.kdf_salt, ctx.state.kdf_iters);
  const r = await rpc('unlock_room', { p_token: authToken });
  if (!r || !r.ok) {
    if (r && r.locked) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED', detail: String(r.retry_after || 300) });
    return false;
  }
  const wk = await rpc('get_wrapped_key');
  ctx.roomKey = await C.unwrapRoomKey(kek, wk.wrapped, wk.iv);
  ctx.kek = kek;
  ctx.epoch = wk.epoch;
  return true;
}

/* ---------- masuk chat ---------- */
async function enterChat() {
  if (chat) { chat.destroy(); chat = null; }
  ctx.loggingOut = false;
  chat = new Chat(ctx, { requestLogout, recoverReset, sessionLost });
  show('chat');
  await chat.start();
}

/* ---------- logout = reset room ---------- */
async function requestResetPayload() {
  const nk = await C.generateRoomKey();
  return C.wrapRoomKey(ctx.kek, nk);
}

async function recoverReset() {
  const w = await requestResetPayload();
  await callFunction('reset-room', { wrapped: w.wrapped, iv: w.iv, logout: false });
}

function requestLogout() {
  showError($('#logout-err'), '');
  $('#dlg-logout').showModal();
}

function wireLogout() {
  const dlg = $('#dlg-logout');
  $('#logout-cancel').addEventListener('click', () => dlg.close());
  $('#logout-confirm').addEventListener('click', async () => {
    const btn = $('#logout-confirm');
    const err = $('#logout-err');
    showError(err, '');
    setBusy(btn, true, 'Menghapus…');
    ctx.loggingOut = true;
    try {
      const w = await requestResetPayload();
      await callFunction('reset-room', { wrapped: w.wrapped, iv: w.iv, logout: true });
    } catch {
      // Reset gagal: JANGAN mengaku berhasil dan JANGAN logout.
      ctx.loggingOut = false;
      showError(err, 'Reset room gagal, Anda belum logout dan chat belum dihapus. Periksa koneksi lalu coba lagi.');
      setBusy(btn, false);
      return;
    }
    setBusy(btn, false);
    dlg.close();
    if (chat) { chat.destroy(); chat = null; }
    stopHeartbeat();
    ctx.userId = null;
    wipeMemory();
    await safeSignOut();
    purgeAuthStorage();
    ctx.loggingOut = false;
    showLogin('Anda telah logout. Seluruh chat dan foto telah dihapus.');
  });
}

/* ---------- start ---------- */
async function init() {
  wireLogin();
  wireUnlock();
  wireLogout();
  $('#fatal-retry').addEventListener('click', () => location.reload());

  sb.auth.onAuthStateChange((evt) => {
    // Token tidak dapat diperbarui / sesi dicabut dari luar.
    if (evt === 'SIGNED_OUT' && ctx.userId && !ctx.loggingOut) sessionLost();
  });

  show('loading');
  try {
    const { data } = await sb.auth.getSession();
    if (data && data.session) await afterAuth(data.session);
    else showLogin('');
  } catch {
    showFatal('Tidak dapat terhubung ke server. Periksa koneksi dan konfigurasi.');
  }
}

init();
