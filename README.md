# twochat — chat privat untuk dua orang

Aplikasi chat dua pengguna dengan end-to-end encryption, tampilan gelap monokrom, dan sepenuhnya berjalan di layanan gratis:
**frontend di GitHub Pages**, **backend di Supabase (free tier)**. Tanpa VPS, tanpa server sendiri.

Fitur: pesan teks realtime, balasan (reply), foto terenkripsi, emoji, sent/delivered/read, online & mengetik, timer pesan global
(30 detik – 7 hari – tidak terhapus), satu perangkat aktif per akun, dan **logout = hapus seluruh chat untuk kedua pengguna**.

> Baca juga: [`docs/KEAMANAN.md`](docs/KEAMANAN.md) (cara kerja kunci, risiko, dan batasan yang jujur) dan
> [`docs/TESTING.md`](docs/TESTING.md) (checklist uji di Supabase asli).

---

## Isi paket

```
index.html            halaman tunggal (login, password room, chat, dialog, error, loading)
css/style.css         desain
js/                   config, boot, api, crypto, chat, realtime, photos, emoji, ui, app
vendor/               (opsional) salinan lokal supabase-js
supabase/sql/         01_setup.sql  02_cron.sql  03_register_users.sql
supabase/functions/   reset-room/  cleanup/   (Edge Functions)
.github/workflows/    keepalive.yml (mencegah project Supabase di-pause)
tests/                uji kripto, sintaks, dan uji end-to-end browser (server tiruan)
docs/                 KEAMANAN.md, TESTING.md
```

## Yang Anda butuhkan
- Akun **GitHub** (gratis) dan akun **Supabase** (gratis, https://supabase.com).
- Browser modern (Chrome/Edge/Firefox/Safari terbaru). Tidak perlu menginstal apa pun untuk langkah 1–9.

---

## Langkah 1 — Buat project Supabase
1. Masuk ke https://supabase.com → **New project**. Beri nama bebas (mis. `twochat`), buat **Database Password** yang kuat (simpan), pilih region terdekat (mis. Singapore).
2. Tunggu project siap. Buka **Project Settings → API** dan catat dua hal:
   - **Project URL** (bentuk: `https://abcdxyz.supabase.co`)
   - **anon / public key** (atau "publishable key")
3. ⚠️ **Jangan pernah** memakai atau menyalin **service_role / secret key** ke repo atau ke `config.js`.

## Langkah 2 — Matikan pendaftaran publik
Buka **Authentication → Sign In / Providers** (nama menu dapat sedikit berbeda):
- **Matikan** "Allow new users to sign up".
- Pada provider **Email**, **matikan** "Confirm email".
- Pastikan "Allow anonymous sign-ins" juga mati.

## Langkah 3 — Buat tabel, aturan keamanan (RLS), dan fungsi
1. Buka **SQL Editor → New query**.
2. Salin seluruh isi `supabase/sql/01_setup.sql`, tempel, klik **Run**. Harus selesai tanpa error.
   (Aman dijalankan ulang. Gunakan project kosong/baru agar jumlah akun tepat dua.)

## Langkah 4 — Buat dua akun
Akun dibuat manual oleh Anda (tidak ada halaman daftar).
1. **Authentication → Users → Add user → Create new user**.
2. Isi **Email** dengan pola `username@twochat.invalid` — contoh `ayu@twochat.invalid` dan `budi@twochat.invalid`.
   Username hanya huruf kecil/angka/titik/strip/garis bawah, 2–20 karakter. Isi **password login** yang kuat. Centang **Auto Confirm User**. Ulangi untuk akun kedua.
3. Buka `supabase/sql/03_register_users.sql`, **ganti dua email** di dalamnya dengan email yang tadi Anda buat, jalankan di SQL Editor. Hasil akhir harus menampilkan 2 baris (slot A dan B).

> Jika dashboard menolak domain `.invalid` (pesan "email address is invalid"): pakai domain lain yang valid untuk dua akun,
> lalu ubah `EMAIL_TEMPLATE` di `js/config.js` agar sesuai (mis. `'{u}@domainanda.com'`), dan sesuaikan email di `03_register_users.sql`.
> Hindari domain milik orang lain karena email pemulihan password bisa sampai ke mereka.

## Langkah 5 — Pasang dua Edge Function
Dua fungsi ini dibutuhkan untuk menghapus file foto di Storage (reset room dan pembersihan pesan kedaluwarsa).

**Lewat dashboard (paling mudah):**
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Nama: `reset-room`. Hapus isi contoh, tempel seluruh `supabase/functions/reset-room/index.ts`, **Deploy**.
3. Buka pengaturan fungsi itu dan **matikan "Verify JWT"** (fungsi memverifikasi token sendiri; ini juga perlu agar CORS dari browser lolos).
4. Ulangi untuk fungsi `cleanup` dengan `supabase/functions/cleanup/index.ts` (juga matikan "Verify JWT").
5. **Edge Functions → Secrets**, tambahkan:
   - `CRON_SECRET` = teks acak panjang (≥ 32 karakter, mis. dari password manager).
   - `ALLOWED_ORIGIN` = alamat situs Anda **tanpa path**, mis. `https://usernameanda.github.io` (disarankan; lewati dulu bila belum tahu, isi setelah Langkah 9).

*(Alternatif: Supabase CLI — `supabase functions deploy reset-room` dan `... cleanup`; `supabase/config.toml` sudah mematikan verify_jwt.)*

## Langkah 6 — Pembersihan terjadwal (disarankan)
1. Buka `supabase/sql/02_cron.sql`, ganti `PROJECT_REF` (bagian depan Project URL) dan `GANTI_RAHASIA_CRON` (nilai yang sama dengan `CRON_SECRET`).
2. Jalankan di SQL Editor. **Jangan simpan versi yang sudah terisi rahasia ke repository.**
3. Jika `pg_cron` tidak tersedia di plan Anda, aplikasi tetap membersihkan pesan kedaluwarsa dari tampilan dan memicu fungsi `cleanup` dari klien yang sedang terbuka; hanya penghapusan fisik yang tertunda sampai ada yang membuka aplikasi.

## Langkah 7 — Isi konfigurasi frontend
Edit `js/config.js`:
```js
SUPABASE_URL: 'https://abcdxyz.supabase.co',   // Project URL Anda
SUPABASE_ANON_KEY: 'eyJ...atau sb_publishable_...',  // anon/publishable key
EMAIL_TEMPLATE: '{u}@twochat.invalid',        // samakan dengan Langkah 4
```

## Langkah 8 — (Disarankan) salinan lokal supabase-js
Ikuti `vendor/README.txt` (satu file). Tanpa ini, aplikasi memuat library yang sama dari CDN jsDelivr dengan versi terkunci.

## Langkah 9 — Coba di komputer, lalu publikasikan
**Coba lokal** (butuh Python atau Node):
```
python3 -m http.server 8000      # lalu buka http://localhost:8000
```
**Publikasikan ke GitHub Pages:**
1. Buat repository **publik** di GitHub (Pages gratis memerlukan repo publik). Aman karena tidak ada rahasia di dalamnya (anon key memang publik).
2. Unggah seluruh isi folder ini (termasuk file `.nojekyll`).
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
4. Tunggu 1–2 menit; alamat `https://USERNAME.github.io/NAMA-REPO/` muncul di halaman itu.
5. Isi `ALLOWED_ORIGIN` (Langkah 5) dengan `https://USERNAME.github.io`.
6. Aktifkan **2FA** pada akun GitHub dan proteksi branch `main` (lihat docs/KEAMANAN.md — siapa pun yang bisa mengubah repo bisa mengubah kode aplikasi).

## Langkah 10 — Keepalive (cegah project di-pause)
Project free di-pause setelah ±7 hari tanpa aktivitas. Di repo GitHub: **Settings → Secrets and variables → Actions → New repository secret**, buat
`SUPABASE_URL` dan `SUPABASE_ANON_KEY`. Workflow `.github/workflows/keepalive.yml` akan memanggil database tiap hari.
(Workflow terjadwal bisa dinonaktifkan GitHub bila repo tidak ada aktivitas 60 hari — cek tab *Actions* sesekali. Belum bisa saya pastikan bahwa ping ini dihitung sebagai "aktivitas" oleh Supabase; periksa dashboard Anda.)

---

## Pemakaian pertama
1. **Pengguna A** login → karena room belum ada, aplikasi meminta **membuat password room** (min. 12 karakter; sangat disarankan frasa acak 6 kata). Bagikan password ini ke pengguna B **lewat jalur lain** (bukan lewat chat ini).
2. **Pengguna B** login → memasukkan password room yang sama.
3. Mulai chat. Tombol jam = timer pesan; tombol keluar = logout **dan hapus seluruh chat**.

Aturan penting:
- **Menutup tab/browser, internet putus, atau crash tidak menghapus chat.** Setelah dibuka lagi Anda hanya perlu memasukkan password room (kunci tidak disimpan di perangkat).
- Hanya **tombol Logout** yang menghapus chat. Akun hanya bisa aktif di satu perangkat; sesi yang mati (tanpa detak 2 menit) bisa digantikan perangkat lain.
- Password room **tidak bisa dipulihkan** jika lupa. Solusinya reset room (semua pesan hilang) — lihat docs/KEAMANAN.md.

## Pemecahan masalah
| Gejala | Penyebab / solusi |
|---|---|
| "Aplikasi tidak dapat dimulai" | `vendor/supabase.js` tidak ada **dan** CDN tidak terjangkau. Ikuti Langkah 8. |
| "Username atau password salah" padahal benar | Email akun di Supabase tidak sama persis dengan `EMAIL_TEMPLATE` + username. Periksa Langkah 4. |
| "Akun ini tidak diizinkan" | `03_register_users.sql` belum dijalankan / email salah. |
| "Gagal memuat data room" | URL/anon key di `config.js` salah, atau `01_setup.sql` belum berhasil dijalankan. |
| Status menampilkan "menyambung ulang…" terus | Realtime privat gagal: pastikan blok Realtime di `01_setup.sql` berjalan (policy `realtime.messages`). Chat tetap jalan lewat polling 5 detik, tetapi online/mengetik tidak aktif. |
| Logout/reset gagal | Edge Function `reset-room` belum di-deploy, "Verify JWT" masih aktif, atau `ALLOWED_ORIGIN` tidak sama dengan alamat situs. Chat **tidak** terhapus bila reset gagal. |
| Foto tidak muncul | Bucket `chat-files`/policy storage belum terpasang (jalankan ulang `01_setup.sql`). |
| Terkunci setelah salah password room | 5 kali salah → kunci 5 menit (per akun). |

## Menjalankan tes otomatis (opsional)
```
node tests/crypto.test.mjs          # uji kripto
node tests/syntax.test.mjs          # cek sintaks semua modul + Edge Function (Node >= 22.6)
python3 tests/browser/e2e.py        # uji dua-browser terhadap server tiruan (butuh playwright + chromium)
```
Uji e2e memakai **server tiruan** yang meniru perilaku fungsi SQL — ia menguji logika klien, bukan Supabase asli.
Lakukan checklist di `docs/TESTING.md` pada Supabase Anda sebelum dipakai sungguhan.
