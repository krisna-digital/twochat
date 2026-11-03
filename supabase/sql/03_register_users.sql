-- =====================================================================
-- Daftarkan dua akun sebagai anggota room.
-- Jalankan SETELAH membuat dua user di Authentication -> Users (lihat README).
-- Ganti dua email di bawah dengan email akun yang Anda buat
-- (format: username@twochat.invalid sesuai EMAIL_TEMPLATE di js/config.js).
-- =====================================================================
insert into public.room_members (user_id, username, slot)
select id, split_part(lower(email), '@', 1), 'A' from auth.users where lower(email) = 'usera@twochat.invalid'
on conflict do nothing;

insert into public.room_members (user_id, username, slot)
select id, split_part(lower(email), '@', 1), 'B' from auth.users where lower(email) = 'userb@twochat.invalid'
on conflict do nothing;

-- Pemeriksaan: harus tampil 2 baris.
select slot, username from public.room_members order by slot;
