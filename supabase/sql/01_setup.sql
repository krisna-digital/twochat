-- =====================================================================
-- twochat — skema database, RLS, fungsi, storage, realtime
-- Jalankan SEKALI di Supabase Dashboard -> SQL Editor (project baru/kosong disarankan).
-- Aman dijalankan ulang (idempotent).
-- =====================================================================

-- ---------- 1. Tabel ----------
create table if not exists public.room_members (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{2,20}$'),
  slot     text not null unique check (slot in ('A','B'))
);

create table if not exists public.room_state (
  id               int primary key default 1 check (id = 1),
  initialized      boolean not null default false,
  epoch            int not null default 1,
  status           text not null default 'active' check (status in ('active','resetting')),
  timer_seconds    int check (timer_seconds is null or timer_seconds in (30,60,300,3600,86400,604800)),
  kdf_salt         text,
  kdf_iters        int,
  reset_started_at timestamptz,
  updated_at       timestamptz not null default now()
);
insert into public.room_state (id) values (1) on conflict (id) do nothing;

-- Rahasia room: TIDAK dapat dibaca klien sama sekali (tanpa policy), hanya lewat fungsi.
create table if not exists public.room_secret (
  id               int primary key default 1 check (id = 1),
  key_verifier     text,
  wrapped_room_key text,
  wrapped_iv       text
);
insert into public.room_secret (id) values (1) on conflict (id) do nothing;

create table if not exists public.device_sessions (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  auth_session_id uuid not null,
  last_seen       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create table if not exists public.room_unlocks (
  auth_session_id uuid primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  unlocked_at     timestamptz not null default now()
);

create table if not exists public.unlock_attempts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  fail_count   int not null default 0,
  locked_until timestamptz
);

create table if not exists public.messages (
  id              uuid primary key,
  epoch           int not null,
  sender_id       uuid not null references auth.users(id) on delete cascade,
  ciphertext      text not null check (length(ciphertext) <= 200000),
  iv              text not null check (length(iv) between 16 and 24),
  attachment_path text check (attachment_path is null or attachment_path ~ '^files/[0-9a-f-]{36}\.bin$'),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz
);
create index if not exists messages_created_idx on public.messages (created_at);
create index if not exists messages_expires_idx on public.messages (expires_at) where expires_at is not null;

alter table public.room_members    enable row level security;
alter table public.room_state      enable row level security;
alter table public.room_secret     enable row level security;
alter table public.device_sessions enable row level security;
alter table public.room_unlocks    enable row level security;
alter table public.unlock_attempts enable row level security;
alter table public.messages        enable row level security;

-- ---------- 2. Maksimal dua akun ----------
create or replace function public.enforce_two_users() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if (select count(*) from auth.users) >= 2 then
    raise exception 'Hanya dua akun yang diizinkan';
  end if;
  return new;
end $$;

drop trigger if exists twochat_two_users on auth.users;
create trigger twochat_two_users before insert on auth.users
  for each row execute function public.enforce_two_users();

-- ---------- 3. Fungsi bantu otorisasi ----------
create or replace function public.current_session_id() returns uuid
language sql stable set search_path = public as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid
$$;

-- Anggota room DAN memegang sesi perangkat aktif (heartbeat < 120 detik).
create or replace function public.is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.room_members m
    join public.device_sessions d on d.user_id = m.user_id
    where m.user_id = auth.uid()
      and d.auth_session_id = public.current_session_id()
      and d.last_seen > now() - interval '120 seconds'
  );
$$;

-- Anggota aktif yang sudah membuka room dengan password room pada sesi ini.
create or replace function public.is_unlocked_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active_member() and exists (
    select 1 from public.room_unlocks u
    where u.auth_session_id = public.current_session_id()
      and u.user_id = auth.uid()
  );
$$;

create or replace function public.room_status() returns text
language sql stable security definer set search_path = public as $$
  select status from public.room_state where id = 1
$$;

-- ---------- 4. Policy RLS (baca saja; semua penulisan lewat fungsi) ----------
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members for select to authenticated
  using (public.is_active_member());

drop policy if exists room_state_select on public.room_state;
create policy room_state_select on public.room_state for select to authenticated
  using (public.is_active_member());

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (
    public.is_unlocked_member()
    and public.room_status() = 'active'
    and (expires_at is null or expires_at > now())
  );
-- room_secret, device_sessions, room_unlocks, unlock_attempts: RLS aktif tanpa policy = tertutup untuk klien.

-- ---------- 5. Fungsi sesi perangkat ----------
create or replace function public.claim_session() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := public.current_session_id();
  v_cur public.device_sessions%rowtype;
begin
  if v_uid is null or v_sid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not exists (select 1 from public.room_members where user_id = v_uid) then
    raise exception 'NOT_MEMBER';
  end if;

  -- Serialisasi login bersamaan untuk akun yang sama (mencegah race condition).
  perform pg_advisory_xact_lock(hashtext('twochat-claim:' || v_uid::text));

  select * into v_cur from public.device_sessions where user_id = v_uid;
  if found then
    if v_cur.auth_session_id = v_sid then
      update public.device_sessions set last_seen = now() where user_id = v_uid;
    elsif v_cur.last_seen > now() - interval '120 seconds' then
      raise exception 'SESSION_ACTIVE';
    else
      -- sesi lama sudah kedaluwarsa (tidak ada heartbeat): boleh diganti
      update public.device_sessions
         set auth_session_id = v_sid, last_seen = now(), created_at = now()
       where user_id = v_uid;
      delete from public.room_unlocks where user_id = v_uid;
    end if;
  else
    insert into public.device_sessions (user_id, auth_session_id) values (v_uid, v_sid);
    delete from public.room_unlocks where user_id = v_uid;
  end if;

  return jsonb_build_object('ok', true, 'now', now());
end $$;

create or replace function public.heartbeat() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := public.current_session_id();
  v_n int;
begin
  if v_uid is null or v_sid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.device_sessions set last_seen = now()
   where user_id = v_uid and auth_session_id = v_sid;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'SESSION_REPLACED'; end if;
  return jsonb_build_object('ok', true, 'now', now());
end $$;

-- Melepas sesi tanpa reset (hanya untuk pengguna yang belum membuka room).
create or replace function public.release_session() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := public.current_session_id();
begin
  if v_uid is null or v_sid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from public.room_unlocks where auth_session_id = v_sid;
  delete from public.device_sessions where user_id = v_uid and auth_session_id = v_sid;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 6. Password room ----------
create or replace function public.setup_room(
  p_salt text, p_iters int, p_verifier text, p_wrapped text, p_wrapped_iv text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_init boolean;
begin
  if not public.is_active_member() then raise exception 'NOT_ACTIVE'; end if;
  select initialized into v_init from public.room_state where id = 1 for update;
  if v_init then raise exception 'ALREADY_INITIALIZED'; end if;
  if p_iters is null or p_iters < 200000 or p_iters > 5000000
     or p_verifier is null or p_verifier !~ '^[0-9a-f]{64}$'
     or p_salt is null or length(p_salt) not between 20 and 64
     or p_wrapped is null or length(p_wrapped) not between 60 and 100
     or p_wrapped_iv is null or length(p_wrapped_iv) <> 16 then
    raise exception 'BAD_PARAMS';
  end if;
  update public.room_state
     set initialized = true, kdf_salt = p_salt, kdf_iters = p_iters, updated_at = now()
   where id = 1;
  update public.room_secret
     set key_verifier = p_verifier, wrapped_room_key = p_wrapped, wrapped_iv = p_wrapped_iv
   where id = 1;
  insert into public.room_unlocks (auth_session_id, user_id)
  values (public.current_session_id(), auth.uid())
  on conflict (auth_session_id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Mengembalikan jsonb {ok:true} | {ok:false} | {ok:false, locked:true, retry_after:detik}.
create or replace function public.unlock_room(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_sid  uuid := public.current_session_id();
  v_init boolean;
  v_att  public.unlock_attempts%rowtype;
  v_ver  text;
begin
  if not public.is_active_member() then raise exception 'NOT_ACTIVE'; end if;
  select initialized into v_init from public.room_state where id = 1;
  if not v_init then raise exception 'NOT_INITIALIZED'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'BAD_PARAMS'; end if;

  insert into public.unlock_attempts (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into v_att from public.unlock_attempts where user_id = v_uid for update;
  if v_att.locked_until is not null and v_att.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked', true,
             'retry_after', ceil(extract(epoch from (v_att.locked_until - now())))::int);
  end if;

  select key_verifier into v_ver from public.room_secret where id = 1;
  if encode(sha256(decode(p_token, 'hex')), 'hex') = v_ver then
    update public.unlock_attempts set fail_count = 0, locked_until = null where user_id = v_uid;
    insert into public.room_unlocks (auth_session_id, user_id) values (v_sid, v_uid)
      on conflict (auth_session_id) do nothing;
    return jsonb_build_object('ok', true);
  end if;

  update public.unlock_attempts
     set fail_count   = case when fail_count + 1 >= 5 then 0 else fail_count + 1 end,
         locked_until = case when fail_count + 1 >= 5 then now() + interval '5 minutes' else null end
   where user_id = v_uid;
  return jsonb_build_object('ok', false);
end $$;

create or replace function public.get_wrapped_key() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_st public.room_state%rowtype;
  v_w  text;
  v_iv text;
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  select * into v_st from public.room_state where id = 1;
  if v_st.status <> 'active' then raise exception 'RESETTING'; end if;
  select wrapped_room_key, wrapped_iv into v_w, v_iv from public.room_secret where id = 1;
  return jsonb_build_object('wrapped', v_w, 'iv', v_iv, 'epoch', v_st.epoch);
end $$;

-- ---------- 7. Timer & pesan ----------
create or replace function public.set_timer(p_seconds int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  if p_seconds is null or p_seconds not in (0,30,60,300,3600,86400,604800) then
    raise exception 'BAD_PARAMS';
  end if;
  update public.room_state
     set timer_seconds = nullif(p_seconds, 0), updated_at = now()
   where id = 1 and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'RESETTING'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.send_message(
  p_id uuid, p_epoch int, p_ciphertext text, p_iv text, p_attachment text
) returns public.messages
language plpgsql security definer set search_path = public as $$
declare
  v_st  public.room_state%rowtype;
  v_row public.messages;
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  select * into v_st from public.room_state where id = 1 for share;
  if v_st.status <> 'active' then raise exception 'RESETTING'; end if;
  if v_st.epoch <> p_epoch then raise exception 'EPOCH_MISMATCH'; end if;
  insert into public.messages (id, epoch, sender_id, ciphertext, iv, attachment_path, expires_at)
  values (
    p_id, v_st.epoch, auth.uid(), p_ciphertext, p_iv, p_attachment,
    case when v_st.timer_seconds is null then null
         else now() + make_interval(secs => v_st.timer_seconds) end
  )
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.mark_delivered(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 200 then raise exception 'BAD_PARAMS'; end if;
  update public.messages
     set delivered_at = now()
   where id = any(p_ids) and sender_id <> auth.uid() and delivered_at is null;
end $$;

create or replace function public.mark_read(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 200 then raise exception 'BAD_PARAMS'; end if;
  update public.messages
     set read_at = now(), delivered_at = coalesce(delivered_at, now())
   where id = any(p_ids) and sender_id <> auth.uid() and read_at is null;
end $$;

-- ---------- 8. Reset room (dipanggil oleh Edge Function reset-room) ----------
create or replace function public.begin_reset() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_st public.room_state%rowtype;
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  select * into v_st from public.room_state where id = 1 for update;
  if v_st.status = 'resetting' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  update public.room_state
     set status = 'resetting', reset_started_at = now(), updated_at = now()
   where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.finish_reset(p_wrapped text, p_iv text, p_logout boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_st  public.room_state%rowtype;
begin
  if not public.is_unlocked_member() then raise exception 'NOT_UNLOCKED'; end if;
  select * into v_st from public.room_state where id = 1 for update;
  if v_st.status <> 'resetting' then
    return jsonb_build_object('ok', true, 'already', true);  -- idempotent
  end if;
  if v_st.initialized and (p_wrapped is null or length(p_wrapped) not between 60 and 100
                           or p_iv is null or length(p_iv) <> 16) then
    raise exception 'BAD_PARAMS';
  end if;

  delete from public.messages where true;
  if v_st.initialized then
    update public.room_secret set wrapped_room_key = p_wrapped, wrapped_iv = p_iv where id = 1;
  end if;
  update public.room_state
     set status = 'active', epoch = epoch + 1, reset_started_at = null, updated_at = now()
   where id = 1;

  if coalesce(p_logout, true) then
    delete from public.room_unlocks where user_id = v_uid;
    delete from public.device_sessions where user_id = v_uid;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 9. Pembersihan pesan kedaluwarsa ----------
create or replace function public.cleanup_expired_text() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  delete from public.messages
   where expires_at is not null and expires_at <= now() and attachment_path is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.has_expired_attachments() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages
    where expires_at is not null and expires_at <= now() and attachment_path is not null
  );
$$;

-- Dipanggil GitHub Actions agar project free tidak di-pause karena tidak aktif.
create or replace function public.ping() returns text
language sql stable set search_path = public as $$ select 'ok'::text $$;

-- ---------- 10. Storage (foto terenkripsi) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 4194304, array['application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists chat_files_insert on storage.objects;
create policy chat_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and name ~ '^files/[0-9a-f-]{36}\.bin$'
    and public.is_unlocked_member()
    and public.room_status() = 'active'
  );

drop policy if exists chat_files_select on storage.objects;
create policy chat_files_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.is_unlocked_member());
-- Sengaja TIDAK ada policy update/delete: penghapusan file hanya oleh Edge Function (service role).

-- ---------- 11. Realtime ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.room_state;
  exception when duplicate_object then null;
  end;
end $$;

-- Otorisasi channel privat 'room' (presence + broadcast typing).
drop policy if exists twochat_rt_select on realtime.messages;
create policy twochat_rt_select on realtime.messages for select to authenticated
  using (public.is_active_member() and (select realtime.topic()) = 'room');

drop policy if exists twochat_rt_insert on realtime.messages;
create policy twochat_rt_insert on realtime.messages for insert to authenticated
  with check (public.is_active_member() and (select realtime.topic()) = 'room');

-- ---------- 12. Hak akses ----------
revoke all on all tables in schema public from anon, authenticated;
grant select on public.messages, public.room_state, public.room_members to authenticated;

revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.cleanup_expired_text()    from authenticated;
revoke execute on function public.has_expired_attachments() from authenticated;
revoke execute on function public.enforce_two_users()       from authenticated;
grant  execute on function public.ping() to anon, authenticated;

notify pgrst, 'reload schema';
