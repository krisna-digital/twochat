# Checklist pengujian

Kolom **Otomatis** = tercakup oleh `python3 tests/browser/e2e.py` / `node tests/*.mjs` terhadap *server tiruan* (logika klien).
Semua butir tetap **harus** dicoba manual pada Supabase asli Anda (dua perangkat/browser berbeda).

| # | Skenario | Cara uji manual | Hasil yang diharapkan | Otomatis |
|---|---|---|---|---|
| 1 | Login User A | Login dengan username A | Masuk ke halaman password room / setup | ✅ |
| 2 | Login User B | Idem untuk B | Idem | ✅ |
| 3 | Login gagal | Password login salah | Pesan "Username atau password salah" | ✅ |
| 4 | Password room salah | Masukkan salah | Tetap di halaman password room, pesan error | ✅ |
| 5 | Password room 5× salah | Salah 5 kali | Terkunci 5 menit | ❌ (manual) |
| 6 | Login dari perangkat kedua | A aktif di HP, login A di laptop | Ditolak: "Akun ini sedang aktif di perangkat lain…" | ✅ |
| 7 | Dua perangkat login bersamaan | Login A di dua perangkat dalam detik yang sama | Tepat satu berhasil | ❌ (manual; serialisasi oleh advisory lock di SQL) |
| 8 | Chat realtime | A kirim, B terima tanpa refresh | Muncul < 1–2 detik | ✅ |
| 9 | Foto terenkripsi | Kirim foto; lihat Storage di dashboard | Tampil di B; file `.bin` tidak bisa dibuka sebagai gambar | ✅ |
| 10 | Reply | Balas pesan | Preview tampil; tetap tampil walau pesan asli kedaluwarsa | ✅ (preview) |
| 11 | Sent/delivered/read | A kirim, B buka | ✓ → ✓✓ → ✓✓ tebal | ✅ |
| 12 | Online/typing | A mengetik | B melihat "sedang mengetik…", "online" | ✅ |
| 13 | Timer pesan | Set 30 detik, kirim | Pesan + sumbu menyusut, hilang di kedua sisi | ✅ |
| 14 | Penghapusan pesan kedaluwarsa | Setelah kedaluwarsa cek tabel `messages` dan bucket | Baris & file terhapus (≤ ±1 menit via cron) | ✅ (tiruan); ❌ pg_cron asli |
| 15 | Logout User A | Logout + konfirmasi | Kembali ke login | ✅ |
| 16 | Chat User B terhapus | Lihat B saat A logout | Kosong seketika, banner "Chat telah direset" | ✅ |
| 17 | Login ulang | Login A+B lagi | Room kosong; tidak ada pesan lama | ✅ |
| 18 | Isi database/Storage setelah reset | Cek tabel `messages`, bucket `chat-files` | Kosong; `wrapped_room_key` berubah; `epoch` naik | ✅ (tiruan); ❌ asli |
| 19 | Browser offline | Matikan internet lalu nyalakan | Status "menyambung ulang…" lalu pulih; chat TIDAK terhapus | ⚠️ sebagian |
| 20 | Browser crash/tutup | Tutup tab tanpa logout, buka lagi | Minta password room; riwayat masih ada | ✅ (reload) |
| 21 | Sesi kedaluwarsa | Biarkan perangkat offline > 2 menit lalu login di perangkat lain | Diizinkan; perangkat lama keluar dengan pesan | ✅ |
| 22 | Reset room gagal | Matikan/nonaktifkan fungsi `reset-room` lalu logout | Error tampil; tidak logout; chat utuh | ✅ (tiruan) |
| 23 | Koneksi realtime terputus | Blokir websocket | Pesan tetap masuk lewat polling ≤ 5 dtk | ⚠️ |
| 24 | Akses tidak sah via API | Dengan anon key saja: `GET /rest/v1/messages`, `/rest/v1/room_secret`, `rpc/send_message` | Kosong/ditolak (401/permission denied) | ❌ (manual) |
| 25 | Akun ke-3 | Coba tambah user ke-3 di dashboard / `signUp` via API | Ditolak oleh trigger / sign-up dimatikan | ❌ (manual) |
| 26 | JWT memuat `session_id` | Decode access token (jwt.io) | Ada klaim `session_id` | ❌ (manual, **kritis**: RLS bergantung padanya) |
| 27 | Penghapusan Storage | Setelah reset, cek bucket di dashboard | Kosong (file fisik terhapus, bukan hanya baris) | ❌ (manual, **kritis**) |
| 28 | Policy Realtime | Sambung channel `room` dengan token tanpa sesi aktif | Ditolak | ❌ (manual) |

Catatan 24, contoh dengan curl (ganti nilai):
```
curl "$URL/rest/v1/room_secret?select=*" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
curl "$URL/rest/v1/messages?select=*"    -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```
Keduanya harus menghasilkan error izin atau array kosong.
