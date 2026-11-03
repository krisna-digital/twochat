// Edge Function: cleanup
// Menghapus pesan kedaluwarsa yang punya foto (file di Storage + baris), pesan teks kedaluwarsa,
// dan file yatim (diunggah tapi pesannya tidak pernah terkirim) yang lebih tua dari 30 menit.
// Boleh dipanggil oleh pg_cron (header x-cron-secret) atau oleh pengguna terautentikasi (cadangan dari klien).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    // Otorisasi: rahasia cron ATAU JWT pengguna yang valid.
    const provided = req.headers.get("x-cron-secret") ?? "";
    let authorized = cronSecret.length >= 16 && provided.length > 0 && safeEqual(provided, cronSecret);
    if (!authorized) {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (jwt) {
        const { data, error } = await admin.auth.getUser(jwt);
        authorized = !error && !!data?.user;
      }
    }
    if (!authorized) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

    const bucket = admin.storage.from("chat-files");
    const nowIso = new Date().toISOString();
    let removedMessages = 0;

    // 1) Pesan kedaluwarsa yang memiliki foto: hapus file dulu, baru barisnya.
    const { data: rows, error: selErr } = await admin
      .from("messages").select("id, attachment_path")
      .not("attachment_path", "is", null).lte("expires_at", nowIso).limit(200);
    if (selErr) return json({ ok: false, error: "SELECT_FAILED" }, 500);
    if (rows && rows.length) {
      const paths = rows.map((r) => r.attachment_path as string);
      const { error: rmErr } = await bucket.remove(paths);
      if (rmErr) return json({ ok: false, error: "STORAGE_REMOVE_FAILED" }, 500);
      const { error: delErr } = await admin.from("messages").delete().in("id", rows.map((r) => r.id));
      if (delErr) return json({ ok: false, error: "DELETE_FAILED" }, 500);
      removedMessages += rows.length;
    }

    // 2) Pesan teks kedaluwarsa.
    const { data: n } = await admin.rpc("cleanup_expired_text");
    if (typeof n === "number") removedMessages += n;

    // 3) File yatim > 30 menit.
    let orphans = 0;
    const { data: objs } = await bucket.list("files", { limit: 1000, sortBy: { column: "created_at", order: "asc" } });
    const old = (objs ?? [])
      .filter((o) => o.name && o.name !== ".emptyFolderPlaceholder" && o.created_at && Date.now() - Date.parse(o.created_at) > 30 * 60 * 1000)
      .map((o) => `files/${o.name}`);
    if (old.length) {
      const used = new Set<string>();
      for (const part of chunk(old, 40)) {
        const { data: m } = await admin.from("messages").select("attachment_path").in("attachment_path", part);
        for (const r of m ?? []) used.add(r.attachment_path as string);
      }
      const orphanPaths = old.filter((p) => !used.has(p));
      if (orphanPaths.length) {
        const { error: oErr } = await bucket.remove(orphanPaths);
        if (!oErr) orphans = orphanPaths.length;
      }
    }

    return json({ ok: true, removedMessages, orphans });
  } catch (e) {
    console.error("cleanup: kesalahan:", (e as Error).message);
    return json({ ok: false, error: "INTERNAL" }, 500);
  }
});
