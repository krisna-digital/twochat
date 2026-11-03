export const $ = (sel, root = document) => root.querySelector(sel);

export function show(name) {
  document.querySelectorAll('.screen').forEach((el) => { el.hidden = el.id !== 'screen-' + name; });
}

let toastTimer = null;
export function toast(msg, ms = 3600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

export function showError(el, msg) {
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = msg;
  el.hidden = false;
}

export function setBusy(btn, busy, busyLabel) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    if (busyLabel) btn.textContent = busyLabel;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

// Timestamp Postgres dapat berisi 6 digit pecahan detik; normalkan ke milidetik.
export function parseTs(s) {
  if (typeof s === 'number') return s;
  const norm = String(s).replace(/(\.\d{3})\d+/, '$1').replace(' ', 'T');
  return Date.parse(norm);
}

const TIMER_LABELS = { 0: 'Tidak terhapus', 30: '30 detik', 60: '1 menit', 300: '5 menit', 3600: '1 jam', 86400: '24 jam', 604800: '7 hari' };
export const TIMER_VALUES = [30, 60, 300, 3600, 86400, 604800, 0];
export function timerLabel(sec) { return TIMER_LABELS[sec == null ? 0 : sec] || (sec + ' dtk'); }
export function timerShort(sec) {
  const m = { 0: 'Tetap', 30: '30d', 60: '1m', 300: '5m', 3600: '1j', 86400: '24j', 604800: '7h' };
  return m[sec == null ? 0 : sec] || String(sec);
}

export function fmtTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '.');
  if (d.toDateString() === now.toDateString()) return hm;
  const dm = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  return dm + ' ' + hm;
}
