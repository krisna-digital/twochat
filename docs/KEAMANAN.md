# Keamanan twochat — cara kerja, risiko, dan batasan

Dokumen ini sengaja jujur tentang apa yang dijamin dan apa yang **tidak**.

## 1. Lapisan perlindungan
| Lapisan | Melindungi dari | Mekanisme |
|---|---|---|
| Login (username + password) | Orang asing masuk | Supabase Auth; sign-up dimatikan; trigger menolak akun ke-3; `room_members` berisi tepat 2 orang |
| Sesi perangkat tunggal | Akun dipakai di dua tempat | `device_sessions` (PK per akun), `claim_session()` dengan advisory lock, heartbeat 20 dtk, timeout 120 dtk, RLS mencocokkan `session_id` di JWT |
| Password room | Pihak backend/penyerang database membaca chat | Kunci room diturunkan di perangkat; server tidak pernah melihat password/kunci |
| RLS + fungsi SECURITY DEFINER | Akses API tanpa izin | Klien hanya boleh `SELECT`; semua penulisan lewat fungsi yang memeriksa sesi + unlock + status room |
| Storage privat | Foto bocor | Bucket privat; isi file sudah terenkripsi; tanpa policy hapus/ubah untuk klien |

## 2. Alur kunci (E2E)
**Dibuat:** saat pengguna pertama menyetel password room, perangkatnya
1. membuat salt acak 16 byte,
2. menurunkan `master = PBKDF2-SHA256(password, salt, 600.000 iterasi)`,
3. dari `master` (HKDF) menurunkan `authToken` (bukti pengetahuan) dan `KEK` (pembungkus kunci; non-extractable),
4. membuat `RoomKey` AES-256 acak, membungkusnya dengan `KEK` (AES-GCM), mengirim ke server **hanya** `salt`, `SHA-256(authToken)`, dan `RoomKey` terbungkus.

**Dibagikan:** kedua pengguna mengetahui password room (Anda bagikan di luar aplikasi). Pengguna B menurunkan `KEK` yang sama, membuktikan `authToken` ke server, menerima `RoomKey` terbungkus, dan membukanya secara lokal.

**Disimpan di perangkat:** hanya di memori (CryptoKey non-extractable). Tidak ada kunci/pesan di localStorage/IndexedDB. Token sesi Supabase di localStorage hanyalah token login, bukan otoritas: server tetap memeriksa sesi, heartbeat, dan unlock pada setiap permintaan.

**Dipulihkan:** setiap kali membuka aplikasi, kunci diturunkan ulang dari password room.

**Pesan:** AES-256-GCM, IV acak 96-bit per pesan, AAD = `id|pengirim|epoch` (mencegah pesan dipindah/diputar ke konteks lain). Isi, reply, nama file, ukuran foto, dan kunci per-foto semua berada di dalam payload terenkripsi. Foto: kunci acak per file, JPEG baru di sisi klien (EXIF/GPS terbuang).

**Rotasi:** setiap reset room membuat `RoomKey` baru dan menaikkan `epoch`; ciphertext lama tidak berguna lagi.

**Jika password room hilang:** tidak ada pemulihan (disengaja). Minta admin mereset: di SQL Editor jalankan
`update public.room_state set initialized=false, status='active'; delete from public.messages where true;`
lalu hapus isi bucket `chat-files` dari dashboard; setelah itu pengguna pertama yang login menyetel password room baru.

## 3. Risiko jika password room diketahui pihak ketiga
- Ia **belum** bisa membaca chat live tanpa akun login + sesi aktif (hanya 2 akun, satu perangkat).
- Namun siapa pun yang memegang salinan data server (mis. penyerang database atau pihak dengan akses backend) + password room dapat mendekripsi **semua ciphertext yang masih tersimpan**.
- Sebaliknya, jika password room lemah, penyerang yang memegang salinan database dapat menebaknya secara offline. **Kekuatan E2E = kekuatan password room.** Pakai frasa acak ≥ 6 kata.
- Jika password login salah satu pengguna bocor tetapi password room tidak: penyerang bisa login saat korban tidak aktif, tetapi tidak bisa membuka room (5 salah → kunci 5 menit).
- Jika keduanya bocor: ganti password login di dashboard, lalu reset room dan buat password room baru.

## 4. Yang terlihat oleh server (metadata)
Siapa pengirim, waktu kirim, waktu kedaluwarsa, status delivered/read (beserta waktunya), ukuran ciphertext, ada/tidaknya lampiran, kapan online (presence). Isi pesan, reply, dan foto **tidak** terlihat. Panjang pesan tidak disamarkan (tanpa padding).

## 5. Keputusan teknis yang menyimpang dari rancangan awal
- **PBKDF2-SHA256 (600.000 iterasi), bukan Argon2id.** Argon2id tidak tersedia di Web Crypto dan library WASM-nya tidak bisa saya sertakan/uji di lingkungan pembangunan tanpa internet. PBKDF2 adalah standar Web Crypto yang teruji, tetapi lebih lemah terhadap GPU daripada Argon2id. Mitigasi: password minimal 12 karakter, sangat disarankan frasa acak panjang; parameter disimpan di `room_state` sehingga bisa dinaikkan. Jika ingin Argon2id, ganti hanya fungsi `deriveFromPassword` di `js/crypto.js` (antarmukanya tetap).
- Tanpa Argon2, tidak ada dependensi WASM; satu-satunya library pihak ketiga adalah supabase-js.

## 6. Batasan yang harus Anda ketahui
1. **Kode dikirim dari GitHub Pages.** Pemilik repo/akun GitHub yang dibobol dapat menyisipkan JS jahat yang mencuri password room. Aktifkan 2FA, proteksi branch `main`, dan simpan salinan `supabase.js` lokal (`vendor/`).
2. **Penghapusan fisik tidak dapat saya jamin.** Setelah reset, data hilang dari API, tabel, dan Storage, dan kunci dirotasi. Tetapi sisa baris Postgres sebelum vacuum atau salinan di infrastruktur Supabase di luar kendali Anda. Perlindungan sebenarnya adalah E2E + rotasi kunci. Free tier tidak menyediakan backup otomatis.
3. **Server dapat menghapus, menunda, atau menyusun ulang pesan**, meski tidak dapat memalsukannya (AES-GCM + AAD). Server yang berniat jahat juga dapat menyajikan epoch/kunci lama; jangan dianggap musuh yang dapat dikalahkan oleh aplikasi ini — ini perlindungan terhadap kebocoran data, bukan terhadap backend yang aktif jahat dan mengubah kode klien.
4. **Layar/kamera:** orang yang melihat layar perangkat Anda atau tangkapan layar tidak dicegah.
5. **Sesi di HP:** browser HP dapat menangguhkan tab di latar belakang; sesi dianggap mati setelah 2 menit tanpa detak dan dapat diambil alih perangkat lain. Perangkat lama akan keluar otomatis (tanpa menghapus chat).
6. **Tidak ada notifikasi push** saat aplikasi tertutup.
7. **Free tier:** project di-pause setelah ±7 hari tanpa aktivitas (lihat keepalive), dan ada batas pemakaian; periksa halaman harga Supabase saat ini.
8. **Reset bergantung pada Edge Function.** Jika gagal, chat TIDAK dihapus dan Anda TIDAK logout (UI menampilkan error). Selama status `resetting`, tak ada data yang dapat dibaca; perangkat lain menyelesaikan reset otomatis setelah ±10 detik bila perangkat pemicu mati.
9. **CSP via `<meta>`:** GitHub Pages tidak mengizinkan header HTTP, jadi `frame-ancestors` tidak dapat diterapkan (clickjacking tidak dicegah oleh header).
10. Rate limit login memakai bawaan Supabase Auth; rate limit password room 5 percobaan/5 menit per akun dibuat sendiri.

## 7. Status pengujian (jujur)
- **Diuji otomatis di lingkungan pembangunan:** modul kripto (round-trip, tamper, AAD, kecocokan dengan implementasi referensi, ukuran field vs CHECK SQL), sintaks seluruh JS dan Edge Function, serta 12 skenario end-to-end dua-browser terhadap **server tiruan** (login, setup/unlock room, perangkat kedua, E2E, receipt, reply, foto, typing/online, scroll, timer & kedaluwarsa, reload, sesi kedaluwarsa, reset gagal/berhasil, login ulang).
- **TIDAK dieksekusi di sini:** `01_setup.sql`, `02_cron.sql`, dua Edge Function, Realtime/Storage Supabase asli. SQL hanya ditinjau manual karena tidak ada Postgres/Internet di lingkungan pembangunan. **Jalankan checklist `docs/TESTING.md` pada Supabase Anda** — terutama: JWT memuat `session_id`, policy `realtime.messages`, penghapusan Storage lewat API, dan pg_cron.
- Saya **tidak** menyatakan aplikasi ini "sudah aman" sebelum checklist itu lulus pada instalasi nyata dan Anda meninjau risiko di atas.
