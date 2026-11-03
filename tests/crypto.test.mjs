// Uji unit modul kripto (Node >= 18). Jalankan: node tests/crypto.test.mjs
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, hkdfSync, randomBytes as nodeRandom } from 'node:crypto';
import * as C from '../js/crypto.js';

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

const ITER = 2000; // kecil agar cepat; produksi memakai 600000

await t('b64 / hex round trip', () => {
  const b = new Uint8Array(nodeRandom(100000));
  assert.deepEqual(C.b64d(C.b64e(b)), b);
  assert.equal(C.toHex(C.fromHex('00ff10')), '00ff10');
});

await t('derivasi password: deterministik, beda salt -> beda hasil', async () => {
  const salt = C.newSalt();
  const a = await C.deriveFromPassword('frasa rahasia panjang', salt, ITER);
  const b = await C.deriveFromPassword('frasa rahasia panjang', salt, ITER);
  const c = await C.deriveFromPassword('frasa rahasia panjang', C.newSalt(), ITER);
  const d = await C.deriveFromPassword('frasa rahasia panjanG', salt, ITER);
  assert.equal(a.authToken, b.authToken);
  assert.notEqual(a.authToken, c.authToken);
  assert.notEqual(a.authToken, d.authToken);
  assert.match(a.authToken, /^[0-9a-f]{64}$/);
  assert.equal(a.kek.extractable, false);
});

await t('derivasi cocok dengan implementasi referensi node:crypto (PBKDF2 + HKDF)', async () => {
  const salt = C.newSalt();
  const pw = 'uji referensi 123';
  const { authToken } = await C.deriveFromPassword(pw, salt, ITER);
  const master = pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(C.b64d(salt)), ITER, 32, 'sha256');
  const ref = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'twochat/v1/auth', 32)).toString('hex');
  assert.equal(authToken, ref);
});

await t('verifier = SHA-256 atas byte token (cocok dengan sha256(decode(token,hex)) di Postgres)', async () => {
  const token = C.toHex(C.randomBytes(32));
  const v = await C.verifierOf(token);
  assert.equal(v, createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex'));
});

await t('wrap/unwrap RoomKey; KEK salah gagal; hasil unwrap non-extractable', async () => {
  const salt = C.newSalt();
  const { kek } = await C.deriveFromPassword('password-a-panjang', salt, ITER);
  const { kek: wrong } = await C.deriveFromPassword('password-b-panjang', salt, ITER);
  const rk = await C.generateRoomKey();
  const w = await C.wrapRoomKey(kek, rk);
  assert.equal(C.b64d(w.iv).length, 12);
  assert.ok(w.wrapped.length >= 60 && w.wrapped.length <= 100, 'panjang wrapped harus cocok dengan CHECK di SQL: ' + w.wrapped.length);
  assert.equal(w.iv.length, 16);
  const un = await C.unwrapRoomKey(kek, w.wrapped, w.iv);
  assert.equal(un.extractable, false);
  await assert.rejects(() => C.unwrapRoomKey(wrong, w.wrapped, w.iv));
  // kunci hasil unwrap bisa mendekripsi data yang dienkripsi RoomKey asli
  const id = '11111111-1111-4111-8111-111111111111', sender = '22222222-2222-4222-8222-222222222222';
  const enc = await C.encryptPayload(rk, { v: 1, t: 'text', text: 'halo' }, id, sender, 1);
  const dec = await C.decryptPayload(un, enc, id, sender, 1);
  assert.equal(dec.text, 'halo');
});

await t('enkripsi pesan: round trip unicode, IV unik, ciphertext beda', async () => {
  const rk = await C.generateRoomKey();
  const id = '11111111-1111-4111-8111-111111111111', sender = '22222222-2222-4222-8222-222222222222';
  const payload = { v: 1, t: 'text', text: 'Halo 👋 — ünïcödé\nbaris dua', reply: { id: 'x', from: 'a', preview: 'p' } };
  const e1 = await C.encryptPayload(rk, payload, id, sender, 3);
  const e2 = await C.encryptPayload(rk, payload, id, sender, 3);
  assert.notEqual(e1.iv, e2.iv);
  assert.notEqual(e1.ciphertext, e2.ciphertext);
  assert.equal(e1.iv.length, 16);
  assert.deepEqual(await C.decryptPayload(rk, e1, id, sender, 3), payload);
  assert.ok(!Buffer.from(C.b64d(e1.ciphertext)).toString('utf8').includes('Halo'));
});

await t('integritas: AAD (id/pengirim/epoch) dan ciphertext yang diubah ditolak', async () => {
  const rk = await C.generateRoomKey();
  const id = '11111111-1111-4111-8111-111111111111', sender = '22222222-2222-4222-8222-222222222222';
  const e = await C.encryptPayload(rk, { v: 1, text: 'x' }, id, sender, 1);
  await assert.rejects(() => C.decryptPayload(rk, e, '33333333-3333-4333-8333-333333333333', sender, 1));
  await assert.rejects(() => C.decryptPayload(rk, e, id, '33333333-3333-4333-8333-333333333333', 1));
  await assert.rejects(() => C.decryptPayload(rk, e, id, sender, 2));
  const bytes = C.b64d(e.ciphertext); bytes[0] ^= 1;
  await assert.rejects(() => C.decryptPayload(rk, { iv: e.iv, ciphertext: C.b64e(bytes) }, id, sender, 1));
  const rk2 = await C.generateRoomKey();
  await assert.rejects(() => C.decryptPayload(rk2, e, id, sender, 1));
});

await t('enkripsi file: round trip 2 MB, kunci per file, IV di depan blob, tamper ditolak', async () => {
  const data = new Uint8Array(nodeRandom(2 * 1024 * 1024));
  const f = await C.encryptFile(data);
  assert.equal(f.blob.length, 12 + data.length + 16);
  assert.notDeepEqual(f.blob.slice(12, 40), data.slice(0, 28));
  assert.deepEqual(await C.decryptFile(f.blob, f.key), data);
  const f2 = await C.encryptFile(data);
  assert.notEqual(f.key, f2.key);
  const bad = f.blob.slice(); bad[100] ^= 1;
  await assert.rejects(() => C.decryptFile(bad, f.key));
  await assert.rejects(() => C.decryptFile(f.blob, f2.key));
  await assert.rejects(() => C.decryptFile(new Uint8Array(5), f.key));
});

await t('ukuran field sesuai CHECK SQL (salt 20-64, iv 16)', async () => {
  const salt = C.newSalt();
  assert.ok(salt.length >= 20 && salt.length <= 64, 'salt length ' + salt.length);
});

console.log(`\n${passed} pengujian kripto lulus`);
