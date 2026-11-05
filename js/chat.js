import { CONFIG } from './config.js';
import { sb, rpc, serverNow, setServerClock, callFunction } from './api.js';
import * as C from './crypto.js';
import { $, toast, fmtTime, parseTs, timerLabel, timerShort, TIMER_VALUES, showError, setBusy } from './ui.js';
import { openChannel, closeChannel, peerIsOnline } from './realtime.js';
import { resizeToJpeg } from './photos.js';
import { EMOJI } from './emoji.js';

const PATH_RE = /^files\/[0-9a-f-]{36}\.bin$/;
const SESSION_LOST = ['NOT_ACTIVE', 'NOT_UNLOCKED', 'NOT_AUTHENTICATED', 'SESSION_REPLACED', 'NOT_MEMBER'];

function snippet(p) {
  const t = (p && p.text ? String(p.text) : '').replace(/\s+/g, ' ').trim();
  if (p && p.t === 'image') return t ? 'Foto · ' + t.slice(0, 60) : 'Foto';
  return t.slice(0, 80);
}

export class Chat {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.deps = deps;
    this.map = new Map();      // id -> entry
    this.order = [];           // id terurut menurut created_at
    this.pending = new Set();  // id yang sedang didekripsi
    this.replyTo = null;
    this.stick = true;
    this.unread = 0;
    this.channel = null;
    this.connected = false;
    this.peerOnline = false;
    this.peerTyping = false;
    this.resetting = false;
    this.queue = Promise.resolve();
    this.lastTypingSent = 0;
    this.cleanupTimer = null;
    this.cleanupBlockedUntil = 0;
    this.receiptsBusy = false;
    this.fetching = false;
    this.destroyed = false;
    this.ac = new AbortController();
    this.scroller = $('#messages');
    this.list = $('#list');
    this.input = $('#composer-input');
    // Suara notifikasi lokal; tidak memerlukan layanan eksternal.
    this.messageAudio = new Audio(new URL('../sounds/message.wav', import.meta.url).href);
    this.messageAudio.preload = 'auto';
    this.messageAudio.volume = 100;
    this.soundUnlocked = false;
  }

  /* ---------- siklus hidup ---------- */
  async start() {
    this.bind();
    $('#peer-name').textContent = this.ctx.peer || 'Room privat';
    $('#peer-avatar').textContent = (this.ctx.peer || '?').charAt(0).toUpperCase();
    this.renderTimer();
    this.setStatusLine();
    this.setBanner('');
    this.setComposerEnabled(true);
    this.updateEmpty();
    await this.fetchAll();
    if (this.destroyed) return;
    this.channel = openChannel(this.ctx, {
      onMessage: (p) => this.onMessageChange(p),
      onRoomState: (st) => this.onRoomState(st),
      onPresence: (s) => { this.peerOnline = peerIsOnline(s, this.ctx.userId); this.setStatusLine(); },
      onTyping: (p) => this.onTyping(p),
      onStatus: (s) => this.onChannelStatus(s)
    });
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.pollTick = 0;
    this.pollTimer = setInterval(() => {
      this.pollTick++;
      if (!this.connected || this.pollTick % 6 === 0) this.syncAll();
    }, CONFIG.POLL_MS);
  }

  destroy() {
    this.destroyed = true;
    this.ac.abort();
    clearInterval(this.sweeper);
    clearInterval(this.pollTimer);
    clearTimeout(this.cleanupTimer);
    clearTimeout(this.typingTimer);
    clearTimeout(this.typingStop);
    clearTimeout(this.recoveryTimer);
    closeChannel(this.channel);
    this.channel = null;
    this.clearView();
    this.input.value = '';
    $('#emoji-panel').hidden = true;
    for (const id of ['dlg-logout', 'dlg-timer', 'dlg-photo', 'dlg-lightbox']) {
      const d = document.getElementById(id);
      if (d && d.open) d.close();
    }
  }

  bind() {
    const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: this.ac.signal });
    on($('#composer'), 'submit', (e) => { e.preventDefault(); this.submitComposer(); });
    // Browser memerlukan interaksi pengguna sebelum audio boleh diputar otomatis.
    const unlockSound = () => this.unlockNotificationSound();
    on(document, 'pointerdown', unlockSound);
    on(document, 'keydown', unlockSound);
    const coarse = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
    on(this.input, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); this.submitComposer(); }
    });
    on(this.input, 'input', () => {
      this.autoGrow();
      if (this.input.value.trim()) {
        this.sendTyping(true);
        clearTimeout(this.typingStop);
        this.typingStop = setTimeout(() => this.sendTyping(false), 3000);
      } else {
        this.sendTyping(false);
      }
    });
    on(this.scroller, 'scroll', () => {
      this.stick = this.isNearBottom();
      if (this.stick) { this.unread = 0; this.updateDownButton(); this.flushReceipts(); }
    });
    on($('#btn-down'), 'click', () => { this.stick = true; this.unread = 0; this.updateDownButton(); this.scrollToBottom(); this.flushReceipts(); });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { if (this.stick) this.scrollToBottom(); });
      this.ro.observe(this.list);
      this.ac.signal.addEventListener('abort', () => this.ro.disconnect());
    }
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.syncAll(); this.flushReceipts(); }
    });
    on($('#reply-cancel'), 'click', () => this.cancelReply());
    on($('#btn-attach'), 'click', () => $('#file-input').click());
    on($('#file-input'), 'change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.openPhotoDialog(f);
    });
    // emoji
    this.buildEmojiPanel();
    on($('#btn-emoji'), 'click', () => { const p = $('#emoji-panel'); p.hidden = !p.hidden; });
    on(document, 'keydown', (e) => { if (e.key === 'Escape') $('#emoji-panel').hidden = true; });
    // timer & logout
    on($('#btn-timer'), 'click', () => this.openTimerDialog());
    on($('#btn-logout'), 'click', () => this.deps.requestLogout());
    on($('#dlg-lightbox'), 'click', () => $('#dlg-lightbox').close());
    on($('#dlg-lightbox'), 'close', () => { $('#lightbox-img').removeAttribute('src'); });
  }

  /* ---------- suara notifikasi ---------- */
  unlockNotificationSound() {
    if (this.soundUnlocked || !this.messageAudio) return;
    const audio = this.messageAudio;
    audio.muted = false;
    audio.currentTime = 0;
    this.soundUnlocked = true;
    try {
      const attempt = audio.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } catch { /* browser bisa menolak pemutaran saat belum siap */ }
  }

  playMessageSound() {
    if (!this.soundUnlocked || !this.messageAudio) return;
    try {
      this.messageAudio.currentTime = 0;
      const attempt = this.messageAudio.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } catch { /* audio tidak boleh mengganggu fungsi chat */ }
  }

  /* ---------- util tampilan ---------- */
  isNearBottom() {
    const m = this.scroller;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }
  scrollToBottom() { this.scroller.scrollTop = this.scroller.scrollHeight; }
  updateEmpty() { $('#empty').hidden = this.order.length > 0 || this.resetting; }
  updateDownButton() {
    const b = $('#btn-down');
    b.hidden = this.stick;
    $('#down-count').textContent = this.unread > 0 ? String(this.unread) : '';
  }
  autoGrow() {
    const t = this.input;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }
  setBanner(msg) {
    const b = $('#banner');
    b.textContent = msg || '';
    b.hidden = !msg;
  }
  setComposerEnabled(on) {
    this.input.disabled = !on;
    $('#btn-send').disabled = !on;
    $('#btn-attach').disabled = !on;
    $('#btn-emoji').disabled = !on;
  }
  setStatusLine() {
    const el = $('#peer-status');
    let txt = 'offline';
    let on = false;
    if (!this.connected) txt = 'menyambung ulang…';
    else if (this.peerTyping) { txt = 'sedang mengetik…'; on = true; }
    else if (this.peerOnline) { txt = 'online'; on = true; }
    el.textContent = txt;
    el.classList.toggle('on', on);
  }
  renderTimer() {
    const sec = this.ctx.state ? this.ctx.state.timer_seconds : null;
    $('#timer-label').textContent = timerShort(sec);
    $('#btn-timer').title = 'Timer pesan: ' + timerLabel(sec);
  }
  clearView() {
    for (const e of this.map.values()) if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
    this.map.clear();
    this.order = [];
    this.list.replaceChildren();
    this.cancelReply();
    this.updateEmpty();
  }

  /* ---------- sinkronisasi ---------- */
  onChannelStatus(status) {
    const ok = status === 'SUBSCRIBED';
    const was = this.connected;
    this.connected = ok;
    this.setStatusLine();
    if (ok && !was) this.syncAll();
  }

  async syncAll() {
    if (this.destroyed || this.ctx.loggingOut) return;
    try {
      const { data: st } = await sb.from('room_state').select('*').eq('id', 1).maybeSingle();
      if (st) await this.onRoomState(st);
      if (!this.resetting) await this.fetchAll();
    } catch { /* jaringan: coba lagi pada siklus berikutnya */ }
  }

  async fetchAll() {
    if (this.fetching || this.destroyed) return;
    this.fetching = true;
    try {
      const { data, error } = await sb.from('messages').select('*').order('created_at', { ascending: true }).limit(500);
      if (error || !data) return;
      const ids = new Set(data.map((r) => r.id));
      for (const id of [...this.order]) if (!ids.has(id)) this.removeMessage(id);
      for (const r of data) await this.upsertRow(r);
      this.flushReceipts();
    } finally {
      this.fetching = false;
    }
  }

  onMessageChange(p) {
    if (this.destroyed || this.resetting) return;
    if (p.eventType === 'INSERT') this.upsertRow(p.new, true);
    else if (p.eventType === 'UPDATE') this.upsertRow(p.new, false);
    else if (p.eventType === 'DELETE' && p.old && p.old.id) this.removeMessage(p.old.id);
  }

  onTyping(p) {
    if (p && p.typing) {
      this.peerTyping = true;
      clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => { this.peerTyping = false; this.setStatusLine(); }, 4500);
    } else {
      this.peerTyping = false;
    }
    this.setStatusLine();
  }

  sendTyping(flag) {
    if (!this.channel || !this.connected) return;
    const now = Date.now();
    if (flag && now - this.lastTypingSent < 2500) return;
    if (flag) this.lastTypingSent = now; else this.lastTypingSent = 0;
    try { this.channel.send({ type: 'broadcast', event: 'typing', payload: { typing: !!flag } }); } catch { /* abaikan */ }
  }

  /* ---------- reset room (dari pihak lain atau pemulihan) ---------- */
  async onRoomState(st) {
    if (!st || st.epoch == null || this.destroyed) return;
    this.ctx.state = st;
    this.renderTimer();
    if (this.ctx.loggingOut) return;
    if (st.status === 'resetting') { this.enterResetting(); return; }
    if (this.resetting || st.epoch !== this.ctx.epoch) await this.afterReset();
  }

  enterResetting() {
    if (this.resetting) return;
    this.resetting = true;
    this.clearView();
    this.setComposerEnabled(false);
    this.setBanner('Room sedang direset…');
    clearTimeout(this.recoveryTimer);
    // Jika reset tidak selesai (mis. perangkat yang memulainya mati), selesaikan secara otomatis.
    this.recoveryTimer = setTimeout(async () => {
      if (!this.resetting || this.destroyed) return;
      try { await this.deps.recoverReset(); } catch { this.setBanner('Reset belum selesai. Mencoba lagi…'); }
    }, 10000);
  }

  async afterReset() {
    clearTimeout(this.recoveryTimer);
    try {
      const wk = await rpc('get_wrapped_key');
      this.ctx.roomKey = await C.unwrapRoomKey(this.ctx.kek, wk.wrapped, wk.iv);
      this.ctx.epoch = wk.epoch;
    } catch (e) {
      if (e.code === 'RESETTING') return; // belum selesai, tunggu event berikutnya
      if (SESSION_LOST.includes(e.code)) { this.deps.sessionLost(); return; }
      this.setBanner('Gagal memulihkan kunci room. Muat ulang halaman.');
      return;
    }
    this.resetting = false;
    this.clearView();
    this.setComposerEnabled(true);
    this.setBanner('Chat telah direset. Room kosong.');
    setTimeout(() => { if (!this.resetting) this.setBanner(''); }, 4000);
    await this.fetchAll();
  }

  /* ---------- pesan masuk / render ---------- */
  async upsertRow(row, notifyIncoming = false) {
    if (this.destroyed || this.resetting || !row || !row.id) return;
    const ex = this.map.get(row.id);
    if (ex) {
      ex.row = Object.assign({}, ex.row, row);
      this.updateTicks(ex);
      return;
    }
    if (this.pending.has(row.id)) return;
    this.pending.add(row.id);
    try {
      let payload;
      try {
        payload = await C.decryptPayload(this.ctx.roomKey, row, row.id, row.sender_id, row.epoch);
      } catch {
        payload = { v: 1, t: 'text', text: '[pesan tidak dapat didekripsi]', broken: true };
      }
      if (this.destroyed || this.resetting || this.map.has(row.id)) return;
      const added = this.addEntry(row, payload);
      if (added && notifyIncoming && row.sender_id !== this.ctx.userId) this.playMessageSound();
    } finally {
      this.pending.delete(row.id);
    }
  }

  addEntry(row, payload) {
    const created = parseTs(row.created_at);
    const exp = row.expires_at ? parseTs(row.expires_at) : null;
    if (exp != null && serverNow() >= exp) return false;
    const entry = { row, payload: payload || {}, created, exp, own: row.sender_id === this.ctx.userId, el: null, fuse: null, ticks: null, blobUrl: null };
    entry.el = this.buildEl(entry);
    let idx = this.order.length;
    while (idx > 0 && this.map.get(this.order[idx - 1]).created > created) idx--;
    const before = idx < this.order.length ? this.map.get(this.order[idx]).el : null;
    this.order.splice(idx, 0, row.id);
    this.map.set(row.id, entry);
    const wasStick = this.stick;
    this.list.insertBefore(entry.el, before);
    this.updateEmpty();
    if (entry.own || wasStick) { this.stick = true; this.scrollToBottom(); }
    else { this.unread++; this.updateDownButton(); }
    if (!entry.own) this.flushReceipts();
    return true;
  }

  buildEl(entry) {
    const p = entry.payload;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (entry.own ? 'own' : 'other');
    wrap.dataset.id = entry.row.id;
    const bub = document.createElement('div');
    bub.className = 'bubble';

    if (p.reply && typeof p.reply === 'object') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reply-ref';
      const w = document.createElement('span'); w.className = 'who-r'; w.textContent = String(p.reply.from || '');
      const t = document.createElement('span'); t.className = 'txt-r'; t.textContent = String(p.reply.preview || '');
      b.append(w, t);
      b.addEventListener('click', () => this.jumpTo(p.reply.id));
      bub.append(b);
    }

    if (p.t === 'image' && p.img) {
      const iw = document.createElement('div');
      iw.className = 'img-wrap loading';
      const w = Number(p.img.w), h = Number(p.img.h);
      if (w > 0 && h > 0 && w < 10000 && h < 10000) iw.style.aspectRatio = w + ' / ' + h;
      bub.append(iw);
      this.loadImage(entry, iw);
    }

    if (p.text) {
      const t = document.createElement('div');
      t.className = 'text' + (p.broken ? ' broken' : '');
      t.textContent = String(p.text);
      bub.append(t);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'reply-btn';
    rb.setAttribute('aria-label', 'Balas pesan ini');
    rb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>';
    rb.addEventListener('click', () => this.startReply(entry));
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(entry.created);
    meta.append(rb, time);
    if (entry.own) {
      const tk = document.createElement('span');
      tk.className = 'ticks';
      entry.ticks = tk;
      meta.append(tk);
    }
    bub.append(meta);

    if (entry.exp != null) {
      const f = document.createElement('div');
      f.className = 'fuse';
      const i = document.createElement('i');
      f.append(i);
      entry.fuse = i;
      bub.append(f);
    }
    wrap.append(bub);
    this.updateTicks(entry);
    return wrap;
  }

  updateTicks(entry) {
    if (!entry.ticks) return;
    const r = entry.row;
    if (r.read_at) { entry.ticks.textContent = '✓✓'; entry.ticks.className = 'ticks read'; entry.ticks.title = 'Dibaca'; }
    else if (r.delivered_at) { entry.ticks.textContent = '✓✓'; entry.ticks.className = 'ticks'; entry.ticks.title = 'Terkirim ke perangkat'; }
    else { entry.ticks.textContent = '✓'; entry.ticks.className = 'ticks'; entry.ticks.title = 'Terkirim'; }
  }

  async loadImage(entry, iw) {
    const img = entry.payload.img;
    try {
      if (!img || !PATH_RE.test(String(img.path))) throw new Error('PATH');
      const { data, error } = await sb.storage.from('chat-files').download(img.path);
      if (error || !data) throw new Error('DL');
      const bytes = new Uint8Array(await data.arrayBuffer());
      const plain = await C.decryptFile(bytes, img.key);
      if (!this.map.has(entry.row.id)) return;
      const url = URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
      entry.blobUrl = url;
      const el = document.createElement('img');
      el.alt = 'Foto';
      el.src = url;
      iw.classList.remove('loading');
      iw.replaceChildren(el);
      iw.addEventListener('click', () => this.openLightbox(url));
    } catch {
      iw.classList.remove('loading');
      iw.classList.add('failed');
      iw.textContent = 'Foto tidak tersedia';
    }
  }

  openLightbox(url) {
    $('#lightbox-img').src = url;
    $('#dlg-lightbox').showModal();
  }

  removeMessage(id) {
    const e = this.map.get(id);
    if (!e) return;
    if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
    e.el.remove();
    this.map.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    if (this.replyTo && this.replyTo.id === id) this.cancelReply();
    this.updateEmpty();
  }

  jumpTo(id) {
    const e = this.map.get(id);
    if (!e) { toast('Pesan asli sudah tidak tersedia.'); return; }
    e.el.scrollIntoView({ block: 'center' });
    this.stick = this.isNearBottom();
    e.el.classList.add('flash');
    setTimeout(() => e.el.classList.remove('flash'), 1300);
  }

  /* ---------- kedaluwarsa ---------- */
  sweep() {
    const now = serverNow();
    let removed = false;
    for (const id of [...this.order]) {
      const e = this.map.get(id);
      if (!e || e.exp == null) continue;
      if (now >= e.exp) { this.removeMessage(id); removed = true; continue; }
      const total = e.exp - e.created;
      const frac = total > 0 ? Math.max(0, Math.min(1, (e.exp - now) / total)) : 0;
      e.fuse.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
    }
    if (removed) this.scheduleCleanup();
  }

  // Penghapusan fisik (terutama foto di Storage) dilakukan server; ini hanya pemicu cadangan di luar cron.
  scheduleCleanup() {
    if (this.cleanupTimer || Date.now() < this.cleanupBlockedUntil) return;
    this.cleanupTimer = setTimeout(async () => {
      this.cleanupTimer = null;
      this.cleanupBlockedUntil = Date.now() + 30000;
      try { await callFunction('cleanup', {}); } catch { /* fungsi opsional; cron menjadi jalur utama */ }
    }, 4000);
  }

  /* ---------- receipt ---------- */
  async flushReceipts() {
    if (this.receiptsBusy || this.resetting || this.destroyed) return;
    this.receiptsBusy = true;
    try {
      const inc = this.order.map((id) => this.map.get(id)).filter((e) => e && !e.own);
      const d = inc.filter((e) => !e.row.delivered_at).map((e) => e.row.id).slice(0, 200);
      if (d.length) {
        await rpc('mark_delivered', { p_ids: d });
        const t = new Date().toISOString();
        for (const id of d) { const e = this.map.get(id); if (e && !e.row.delivered_at) e.row.delivered_at = t; }
      }
      if (document.visibilityState === 'visible' && this.stick) {
        const r = inc.filter((e) => !e.row.read_at).map((e) => e.row.id).slice(0, 200);
        if (r.length) {
          await rpc('mark_read', { p_ids: r });
          const t = new Date().toISOString();
          for (const id of r) { const e = this.map.get(id); if (e) { e.row.read_at = e.row.read_at || t; e.row.delivered_at = e.row.delivered_at || t; } }
        }
      }
    } catch (e) {
      if (SESSION_LOST.includes(e.code)) this.deps.sessionLost();
    } finally {
      this.receiptsBusy = false;
    }
  }

  /* ---------- kirim ---------- */
  startReply(entry) {
    this.replyTo = {
      id: entry.row.id,
      from: entry.own ? this.ctx.username : (this.ctx.peer || ''),
      preview: snippet(entry.payload)
    };
    $('#reply-who').textContent = entry.own ? 'Anda' : (this.ctx.peer || '');
    $('#reply-text').textContent = this.replyTo.preview;
    $('#reply-bar').hidden = false;
    this.input.focus();
  }
  cancelReply() {
    this.replyTo = null;
    $('#reply-bar').hidden = true;
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  async submitComposer() {
    const text = this.input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (this.resetting) { toast('Room sedang direset. Tunggu sebentar.'); return; }
    if (text.length > CONFIG.MAX_TEXT) { toast('Pesan terlalu panjang.'); return; }
    const reply = this.replyTo ? Object.assign({}, this.replyTo) : null;
    this.input.value = '';
    this.autoGrow();
    this.cancelReply();
    clearTimeout(this.typingStop);
    this.sendTyping(false);
    this.enqueue(async () => {
      try {
        await this.sendPayload({ v: 1, t: 'text', text, reply, sent: new Date().toISOString() }, null);
      } catch (e) {
        if (!this.input.value) { this.input.value = text; this.autoGrow(); }
        this.handleSendError(e);
      }
    });
  }

  async sendPayload(payload, attachmentPath) {
    const id = crypto.randomUUID();
    const epoch = this.ctx.epoch;
    const { ciphertext, iv } = await C.encryptPayload(this.ctx.roomKey, payload, id, this.ctx.userId, epoch);
    const row = await rpc('send_message', { p_id: id, p_epoch: epoch, p_ciphertext: ciphertext, p_iv: iv, p_attachment: attachmentPath });
    if (row && row.created_at) setServerClock(row.created_at);
    this.stick = true;
    await this.upsertRow(row);
    this.scrollToBottom();
  }

  handleSendError(e) {
    if (SESSION_LOST.includes(e.code)) { this.deps.sessionLost(); return; }
    if (e.code === 'EPOCH_MISMATCH' || e.code === 'RESETTING') toast('Room baru saja direset. Coba kirim lagi sebentar lagi.');
    else toast('Pesan gagal dikirim. Periksa koneksi Anda.');
  }

  /* ---------- foto ---------- */
  async openPhotoDialog(file) {
    const dlg = $('#dlg-photo');
    const err = $('#photo-err');
    showError(err, '');
    if (this.resetting) { toast('Room sedang direset. Tunggu sebentar.'); return; }
    if (!file.type.startsWith('image/')) { toast('Hanya file gambar yang bisa dikirim.'); return; }
    if (file.size > CONFIG.MAX_PHOTO_INPUT_MB * 1024 * 1024) { toast('Foto terlalu besar.'); return; }
    let jpeg;
    try { jpeg = await resizeToJpeg(file); } catch { toast('Foto tidak dapat dibaca.'); return; }
    const url = URL.createObjectURL(jpeg.blob);
    $('#photo-preview').src = url;
    $('#photo-caption').value = '';
    const sendBtn = $('#photo-send');
    const cancelBtn = $('#photo-cancel');
    const cleanup = () => {
      sendBtn.removeEventListener('click', doSend);
      cancelBtn.removeEventListener('click', doCancel);
      dlg.removeEventListener('close', onClose);
      URL.revokeObjectURL(url);
      $('#photo-preview').removeAttribute('src');
    };
    const doCancel = () => dlg.close();
    const onClose = () => cleanup();
    const doSend = async () => {
      setBusy(sendBtn, true, 'Mengirim…');
      showError(err, '');
      try {
        await this.sendPhoto(jpeg, $('#photo-caption').value.trim());
        dlg.close();
      } catch (e) {
        if (SESSION_LOST.includes(e.code)) { dlg.close(); this.deps.sessionLost(); }
        else showError(err, 'Foto gagal dikirim. Coba lagi.');
      } finally {
        setBusy(sendBtn, false);
      }
    };
    sendBtn.addEventListener('click', doSend);
    cancelBtn.addEventListener('click', doCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  }

  async sendPhoto(jpeg, caption) {
    const reply = this.replyTo ? Object.assign({}, this.replyTo) : null;
    const bytes = new Uint8Array(await jpeg.blob.arrayBuffer());
    const { blob, key } = await C.encryptFile(bytes);
    const path = 'files/' + crypto.randomUUID() + '.bin';
    const up = await sb.storage.from('chat-files').upload(path, new Blob([blob], { type: 'application/octet-stream' }), {
      contentType: 'application/octet-stream', upsert: false, cacheControl: '0'
    });
    if (up.error) throw new Error('UPLOAD_FAILED');
    const payload = { v: 1, t: 'image', text: caption, reply, img: { path, key, w: jpeg.w, h: jpeg.h }, sent: new Date().toISOString() };
    await this.sendPayload(payload, path);
    this.cancelReply();
  }

  /* ---------- emoji ---------- */
  buildEmojiPanel() {
    const panel = $('#emoji-panel');
    if (panel.childElementCount) return;
    for (const [title, list] of EMOJI) {
      const h = document.createElement('h3');
      h.textContent = title;
      panel.append(h);
      for (const em of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = em;
        b.setAttribute('aria-label', em);
        b.addEventListener('click', () => {
          const t = this.input;
          const s = t.selectionStart == null ? t.value.length : t.selectionStart;
          const e = t.selectionEnd == null ? s : t.selectionEnd;
          t.setRangeText(em, s, e, 'end');
          t.dispatchEvent(new Event('input'));
          t.focus();
        });
        panel.append(b);
      }
    }
  }

  /* ---------- timer ---------- */
  openTimerDialog() {
    const dlg = $('#dlg-timer');
    const box = $('#timer-options');
    const err = $('#timer-err');
    showError(err, '');
    const cur = this.ctx.state && this.ctx.state.timer_seconds != null ? this.ctx.state.timer_seconds : 0;
    box.replaceChildren();
    for (const v of TIMER_VALUES) {
      const lab = document.createElement('label');
      const inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = 'timer';
      inp.value = String(v);
      inp.checked = v === cur;
      const sp = document.createElement('span');
      sp.textContent = timerLabel(v);
      lab.append(inp, sp);
      box.append(lab);
    }
    const save = $('#timer-save');
    const cancel = $('#timer-cancel');
    const done = () => { save.removeEventListener('click', onSave); cancel.removeEventListener('click', onCancel); };
    const onCancel = () => { done(); dlg.close(); };
    const onSave = async () => {
      const sel = box.querySelector('input:checked');
      if (!sel) return;
      setBusy(save, true, 'Menyimpan…');
      try {
        await rpc('set_timer', { p_seconds: Number(sel.value) });
        done();
        dlg.close();
        toast('Timer diubah: ' + timerLabel(Number(sel.value)));
      } catch (e) {
        if (SESSION_LOST.includes(e.code)) { done(); dlg.close(); this.deps.sessionLost(); }
        else showError(err, 'Gagal mengubah timer.');
      } finally {
        setBusy(save, false);
      }
    };
    save.addEventListener('click', onSave);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('close', done, { once: true });
    dlg.showModal();
  }
}
