// Edge Function: reset-room
// Menghapus SELURUH isi room (pesan + file di Storage), merotasi kunci room, dan (opsional) mencabut sesi pemanggil.
// Urutan aman: begin_reset (kunci room, status 'resetting') -> hapus Storage -> finish_reset (hapus pesan + kunci baru, satu transaksi).
// Idempotent: jika gagal di tengah, room tetap 'resetting' (tidak ada data yang bisa dibaca) dan dapat diulang.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function wipeStorage(admin: ReturnType<typeof createClient>) {
  const bucket = admin.storage.from("chat-files");
  for (let i = 0; i < 200; i++) {
    const { data, error } = await bucket.list("files", { limit: 1000 });
    if (error) throw new Error("STORAGE_LIST_FAILED");
    if (!data || data.length === 0) return;
    const paths = data.filter((o) => o.name).map((o) => `files/${o.name}`);
    if (paths.length === 0) return;
    const { error: rmErr } = await bucket.remove(paths);
    if (rmErr) throw new Error("STORAGE_REMOVE_FAILED");
  }
  throw new Error("STORAGE_TOO_MANY");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ ok: false, error: "NO_AUTH" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const body = await req.json().catch(() => ({}));
    const logout = body.logout !== false;

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ ok: false, error: "BAD_TOKEN" }, 401);

    // Dijalankan sebagai pengguna (bukan service role) agar RLS/otorisasi sesi + unlock tetap berlaku.
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const b = await userClient.rpc("begin_reset");
    if (b.error) return json({ ok: false, error: b.error.message }, 403);

    try {
      await wipeStorage(admin);
    } catch (e) {
      console.error("reset: storage wipe gagal:", (e as Error).message);
      return json({ ok: false, error: "STORAGE_FAILED" }, 500);
    }

    const f = await userClient.rpc("finish_reset", {
      p_wrapped: typeof body.wrapped === "string" ? body.wrapped : "",
      p_iv: typeof body.iv === "string" ? body.iv : "",
      p_logout: logout,
    });
    if (f.error) {
      console.error("reset: finish_reset gagal:", f.error.message);
      return json({ ok: false, error: "FINISH_FAILED" }, 500);
    }

    if (logout) {
      try { await admin.auth.admin.signOut(jwt, "global"); } catch (e) {
        console.error("reset: signOut gagal:", (e as Error).message);
      }
    }
    return json({ ok: true });
  } catch (e) {
    console.error("reset: kesalahan:", (e as Error).message);
    return json({ ok: false, error: "INTERNAL" }, 500);
  }
});
