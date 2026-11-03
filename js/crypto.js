// Semua kriptografi memakai Web Crypto API standar. Tidak ada algoritma buatan sendiri.
//
//  password room --PBKDF2-SHA256(salt, iterasi)--> master (256 bit)
//  master --HKDF "twochat/v1/auth"--> authToken  (dikirim ke server sebagai bukti; server hanya menyimpan SHA-256-nya)
//  master --HKDF "twochat/v1/kek" --> KEK        (tidak pernah meninggalkan perangkat; non-extractable)
//  RoomKey (AES-256-GCM acak) dibungkus KEK dan disimpan di server hanya dalam bentuk terbungkus.
//  Pesan: AES-256-GCM, IV acak 96-bit per pesan, AAD = id|pengirim|epoch.
//  Foto : AES-256-GCM dengan kunci acak per file (kunci ada di dalam payload pesan terenkripsi).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64e(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(s);
}

export function b64d(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new Error('HEX_INVALID');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function newSalt() { return b64e(randomBytes(16)); }

// SHA-256 atas byte dari token heksadesimal (cocok dengan sha256(decode(token,'hex')) di Postgres).
export async function verifierOf(authTokenHex) {
  return toHex(await subtle.digest('SHA-256', fromHex(authTokenHex)));
}

export async function deriveFromPassword(password, saltB64, iterations) {
  const pw = enc.encode(String(password).normalize('NFKC'));
  const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  pw.fill(0);
  const masterBits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations },
    base, 256
  );
  const hk = await subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  new Uint8Array(masterBits).fill(0);
  const empty = new Uint8Array(0);
  const authBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: empty, info: enc.encode('twochat/v1/auth') }, hk, 256
  );
  const kek = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: empty, info: enc.encode('twochat/v1/kek') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  return { authToken: toHex(authBits), kek };
}

export function generateRoomKey() {
  // extractable=true hanya agar bisa dibungkus; hasil unwrap selalu non-extractable.
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

const AAD_ROOMKEY = enc.encode('twochat/roomkey/v1');

export async function wrapRoomKey(kek, roomKey) {
  const raw = new Uint8Array(await subtle.exportKey('raw', roomKey));
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD_ROOMKEY }, kek, raw);
  raw.fill(0);
  return { wrapped: b64e(ct), iv: b64e(iv) };
}

export async function unwrapRoomKey(kek, wrappedB64, ivB64) {
  const raw = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: b64d(ivB64), additionalData: AAD_ROOMKEY }, kek, b64d(wrappedB64)
  ));
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return key;
}

function msgAad(id, senderId, epoch) {
  return enc.encode('twochat/msg/v1|' + id + '|' + senderId + '|' + epoch);
}

export async function encryptPayload(roomKey, obj, id, senderId, epoch) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: msgAad(id, senderId, epoch) },
    roomKey, enc.encode(JSON.stringify(obj))
  );
  return { ciphertext: b64e(ct), iv: b64e(iv) };
}

export async function decryptPayload(roomKey, row, id, senderId, epoch) {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64d(row.iv), additionalData: msgAad(id, senderId, epoch) },
    roomKey, b64d(row.ciphertext)
  );
  return JSON.parse(dec.decode(pt));
}

const AAD_FILE = enc.encode('twochat/file/v1');

// Hasil: blob = IV(12 byte) || ciphertext, dan kunci file (base64) untuk disimpan dalam payload pesan.
export async function encryptFile(bytes) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD_FILE }, key, bytes));
  const blob = new Uint8Array(12 + ct.length);
  blob.set(iv, 0);
  blob.set(ct, 12);
  const raw = new Uint8Array(await subtle.exportKey('raw', key));
  const keyB64 = b64e(raw);
  raw.fill(0);
  return { blob, key: keyB64 };
}

export async function decryptFile(blobBytes, keyB64) {
  if (blobBytes.length < 13 + 16) throw new Error('FILE_TOO_SHORT');
  const raw = b64d(keyB64);
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  raw.fill(0);
  const iv = blobBytes.slice(0, 12);
  const ct = blobBytes.slice(12);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD_FILE }, key, ct));
}
