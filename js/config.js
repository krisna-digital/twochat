// Konfigurasi publik. Aman ada di repository: anon key memang dirancang publik.
// JANGAN PERNAH menaruh service_role key di sini atau di file mana pun di repo.
export const CONFIG = {
  SUPABASE_URL: 'https://cvgiddcldnhemjzlmfyj.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dpjKYuCA-bU_F-WHxiduNA_wnPuX-mu',

  // Username dipetakan ke alamat email "palsu" untuk Supabase Auth.
  // Akun di dashboard Supabase harus dibuat dengan email yang sama persis dengan pola ini.
  EMAIL_TEMPLATE: '{u}@twochat.invalid',

  KDF_ITERATIONS: 600000,     // PBKDF2-SHA256 (dipakai saat setup room pertama kali)
  HEARTBEAT_MS: 20000,        // harus jauh di bawah timeout sesi server (120 dtk)
  POLL_MS: 5000,              // cadangan jika realtime terputus
  MAX_TEXT: 4000,
  MAX_PHOTO_INPUT_MB: 25,
  MIN_ROOM_PASSWORD: 12
};
