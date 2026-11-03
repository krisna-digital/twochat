// Memuat supabase-js (utamakan salinan lokal di /vendor, cadangan: CDN versi terkunci), lalu menjalankan aplikasi.
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

function load(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('gagal memuat ' + src));
    document.head.appendChild(s);
  });
}

function fatal(msg) {
  document.querySelectorAll('.screen').forEach((el) => { el.hidden = el.id !== 'screen-fatal'; });
  document.getElementById('fatal-msg').textContent = msg;
  document.getElementById('fatal-retry').addEventListener('click', () => location.reload());
}

(async () => {
  try {
    try { await load('vendor/supabase.js'); } catch { await load(CDN); }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('library supabase tidak tersedia');
    }
    await import('./app.js');
  } catch (e) {
    fatal('Aplikasi tidak dapat dimulai: ' + (e && e.message ? e.message : 'kesalahan tidak dikenal'));
  }
})();
