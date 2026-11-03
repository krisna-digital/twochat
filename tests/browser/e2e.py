#!/usr/bin/env python3
"""Uji end-to-end klien di Chromium (dua pengguna) terhadap server tiruan.
Jalankan dari root proyek:  python3 tests/browser/e2e.py
Butuh: node, python3, playwright (python) + chromium."""
import json, os, struct, subprocess, sys, time, urllib.request, zlib
from playwright.sync_api import sync_playwright, Page

# Aplikasi memakai CSP ketat (tanpa unsafe-eval), sehingga wait_for_function bawaan Playwright
# (yang memakai eval di halaman) tidak bisa dipakai. Ganti dengan polling lewat evaluate().
def _wf(self, expression, arg=None, timeout=30000, **kw):
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if self.evaluate(expression, arg): return True
        except Exception: pass
        time.sleep(0.1)
    raise TimeoutError('timeout menunggu: ' + expression[:90])
Page.wait_for_function = _wf

PORT = 8799
BASE = f'http://127.0.0.1:{PORT}'
fails = []
errors = []

def check(cond, msg):
    print(('  ok   ' if cond else '  GAGAL ') + msg)
    if not cond: fails.append(msg)

def dump():
    return json.load(urllib.request.urlopen(BASE + '/test/dump'))

def hit(path):
    urllib.request.urlopen(BASE + path).read()

def png(w=400, h=300):
    raw = b''.join(b'\x00' + bytes([(x * 255 // w), (y * 255 // h), 128]) * 1 if False else b'\x00' + b''.join(bytes([x * 255 // w, y * 255 // h, 128]) for x in range(w)) for y in range(h))
    def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

def watch(page, name):
    page.on('pageerror', lambda e: errors.append(f'[{name}] pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'[{name}] console.{m.type}: {m.text}') if m.type == 'error' and 'EventSource' not in m.text and 'ERR_' not in m.text else None)

def login(page, user, pw):
    page.fill('#login-user', user); page.fill('#login-pass', pw); page.click('#login-btn')

def on_screen(page, name, timeout=8000):
    page.wait_for_selector(f'#screen-{name}:not([hidden])', timeout=timeout)

def send(page, text):
    page.fill('#composer-input', text); page.press('#composer-input', 'Enter')

def texts(page):
    return page.eval_on_selector_all('#list .msg .text', 'els => els.map(e => e.textContent)')

def wait_text(page, text, timeout=8000):
    page.wait_for_function('t => [...document.querySelectorAll("#list .msg .text")].some(e => e.textContent === t)', arg=text, timeout=timeout)

def unlock(page, pw):
    page.fill('#unlock-pw', pw); page.click('#unlock-btn')

srv = subprocess.Popen(['node', 'tests/browser/mock-server.mjs'], env={**os.environ, 'PORT': str(PORT)}, stdout=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/test/dump'); break
        except Exception: time.sleep(0.1)

    with sync_playwright() as p:
        br = p.chromium.launch()
        ctxA = br.new_context(viewport={'width': 420, 'height': 800}); A = ctxA.new_page(); watch(A, 'A')
        ctxB = br.new_context(viewport={'width': 420, 'height': 800}); B = ctxB.new_page(); watch(B, 'B')
        ROOMPW = 'kuda hijau menari di atas bulan'

        print('# 1. Login & password room')
        A.goto(BASE + '/'); on_screen(A, 'login')
        login(A, 'usera', 'salah-salah'); A.wait_for_selector('#login-err:not([hidden])')
        check('salah' in A.inner_text('#login-err').lower(), 'login gagal menampilkan pesan error')
        login(A, 'usera', 'passA-12345'); on_screen(A, 'unlock')
        check(A.is_visible('#unlock-pw2'), 'room belum dibuat -> mode setup (konfirmasi password tampil)')
        unlock(A, 'pendek'); A.fill('#unlock-pw2', 'pendek'); A.click('#unlock-btn')
        check('minimal' in A.inner_text('#unlock-err'), 'password room pendek ditolak')
        A.fill('#unlock-pw', ROOMPW); A.fill('#unlock-pw2', 'beda sama sekali ya'); A.click('#unlock-btn')
        check('tidak sama' in A.inner_text('#unlock-err'), 'konfirmasi tidak cocok ditolak')
        A.fill('#unlock-pw2', ROOMPW); A.click('#unlock-btn'); on_screen(A, 'chat')
        check(A.is_visible('#empty'), 'empty state tampil saat room kosong')
        check(A.inner_text('#peer-name') == 'userb', 'header menampilkan nama lawan bicara')
        d = dump()
        check(d['state']['initialized'] and len(d['secret']['verifier']) == 64, 'server menyimpan verifier (hash), bukan password')
        check(ROOMPW not in json.dumps(d), 'password room tidak ada di data server')

        B.goto(BASE + '/'); on_screen(B, 'login'); login(B, 'userb', 'passB-12345'); on_screen(B, 'unlock')
        check(not B.is_visible('#unlock-pw2'), 'pengguna B: mode unlock biasa')
        unlock(B, 'password room salah banget'); B.wait_for_selector('#unlock-err:not([hidden])')
        check('salah' in B.inner_text('#unlock-err').lower() and B.is_visible('#screen-unlock'), 'password room salah: tetap di halaman password room')
        unlock(B, ROOMPW); on_screen(B, 'chat')

        print('# 2. Perangkat kedua ditolak')
        ctxA2 = br.new_context(); A2 = ctxA2.new_page(); watch(A2, 'A2')
        A2.goto(BASE + '/'); on_screen(A2, 'login'); login(A2, 'usera', 'passA-12345')
        A2.wait_for_selector('#login-err:not([hidden])')
        check('aktif di perangkat lain' in A2.inner_text('#login-err'), 'login kedua ditolak dengan pesan yang benar')
        check(A2.evaluate('localStorage.getItem("sb-mock-auth-token")') is None, 'sesi perangkat kedua tidak tersimpan')

        print('# 3. Chat realtime, E2E, receipt, reply')
        B.wait_for_function('document.querySelector("#peer-status").textContent === "online"', timeout=6000)
        check(True, 'B melihat A online')
        send(A, 'Halo B, ini rahasia 🔒')
        wait_text(B, 'Halo B, ini rahasia 🔒')
        check(True, 'pesan A diterima & didekripsi di B')
        d = dump()
        check(len(d['messages']) == 1 and 'rahasia' not in json.dumps(d), 'server hanya menyimpan ciphertext (tidak ada plaintext)')
        A.wait_for_function('document.querySelector(".msg.own .ticks.read")', timeout=8000)
        check(True, 'A melihat centang dibaca (read)')
        B.locator('.msg.other .reply-btn').last.click()
        check(B.is_visible('#reply-bar') and 'Halo B' in B.inner_text('#reply-text'), 'bar reply menampilkan preview')
        send(B, 'Balasan dari B'); wait_text(A, 'Balasan dari B')
        check('Halo B' in A.inner_text('.msg.other .reply-ref'), 'A melihat reply-preview pesan yang dibalas')
        A.click('#btn-emoji'); A.locator('#emoji-panel button').first.click()
        check(len(A.input_value('#composer-input')) > 0, 'emoji picker menyisipkan emoji'); A.fill('#composer-input', ''); A.click('#btn-emoji')

        print('# 4. Foto terenkripsi')
        A.set_input_files('#file-input', files=[{'name': 'x.png', 'mimeType': 'image/png', 'buffer': png()}])
        A.wait_for_selector('#dlg-photo[open]'); A.fill('#photo-caption', 'foto uji'); A.click('#photo-send')
        B.wait_for_selector('.img-wrap img', timeout=10000)
        check(B.evaluate('document.querySelector(".img-wrap img").naturalWidth') > 0, 'B menampilkan foto hasil dekripsi')
        d = dump()
        check(len(d['storage']) == 1 and d['storage'][0]['head'] != 'ffd8ffe0' and not d['storage'][0]['head'].startswith('ffd8'), 'file di storage terenkripsi (bukan JPEG mentah)')
        check(d['storage'][0]['path'].startswith('files/'), 'path storage sesuai pola')

        print('# 5. Typing & status online')
        A.type('#composer-input', 'sedang menu', delay=40)
        B.wait_for_function('document.querySelector("#peer-status").textContent.includes("mengetik")', timeout=5000)
        check(True, 'B melihat indikator sedang mengetik')
        A.fill('#composer-input', '')

        print('# 6. Auto-scroll')
        for i in range(25): send(A, f'pesan scroll {i}')
        wait_text(B, 'pesan scroll 24')
        check(B.evaluate('(() => { const m = document.querySelector("#messages"); return m.scrollHeight - m.scrollTop - m.clientHeight < 90 })()'), 'B di bawah: otomatis ikut ke pesan terbaru')
        B.evaluate('document.querySelector("#messages").scrollTop = 0'); time.sleep(0.3)
        send(A, 'pesan saat B membaca atas'); wait_text(B, 'pesan saat B membaca atas')
        top = B.evaluate('document.querySelector("#messages").scrollTop')
        check(top < 50, f'B membaca pesan lama: tidak dipaksa scroll (scrollTop={top})')
        check(B.is_visible('#btn-down'), 'tombol "ke pesan terbaru" muncul')
        B.click('#btn-down'); time.sleep(0.3)
        check(B.evaluate('(() => { const m = document.querySelector("#messages"); return m.scrollHeight - m.scrollTop - m.clientHeight < 90 })()'), 'tombol turun membawa ke pesan terbaru')

        print('# 7. Timer pesan (30 detik)')
        A.click('#btn-timer'); A.wait_for_selector('#dlg-timer[open]')
        A.locator('#timer-options label', has_text='30 detik').click(); A.click('#timer-save')
        A.wait_for_function('!document.querySelector("#dlg-timer").open')
        B.wait_for_function('document.querySelector("#timer-label").textContent === "30d"', timeout=5000)
        check(True, 'timer 30 detik tampil di kedua sisi')
        n_storage_before = len(dump()['storage'])
        send(A, 'pesan sekejap'); wait_text(B, 'pesan sekejap')
        A.set_input_files('#file-input', files=[{'name': 'y.png', 'mimeType': 'image/png', 'buffer': png(200, 200)}])
        A.wait_for_selector('#dlg-photo[open]'); A.click('#photo-send'); A.wait_for_function('!document.querySelector("#dlg-photo").open')
        B.wait_for_function('document.querySelectorAll(".img-wrap img").length === 2', timeout=10000)
        check(A.locator('.msg.own .fuse').count() >= 1, 'sumbu kedaluwarsa tampil di pesan bertimer')
        check(len(dump()['storage']) == n_storage_before + 1, 'foto bertimer tersimpan')
        print('   (menunggu ±33 detik agar pesan kedaluwarsa)')
        time.sleep(33)
        for name, pg in (('A', A), ('B', B)):
            check('pesan sekejap' not in texts(pg), f'{name}: pesan kedaluwarsa hilang dari tampilan')
        check(B.locator('.img-wrap img').count() == 1, 'foto kedaluwarsa hilang dari tampilan')
        d = dump()
        check(len(d['storage']) == n_storage_before and all('pesan sekejap' not in json.dumps(m) for m in d['messages']), 'server menghapus pesan & foto kedaluwarsa')
        check('pesan saat B membaca atas' in texts(A), 'pesan lama (tanpa timer) tetap ada')
        A.click('#btn-timer'); A.wait_for_selector('#dlg-timer[open]'); A.locator('#timer-options label', has_text='Tidak terhapus').click(); A.click('#timer-save')
        A.wait_for_function('!document.querySelector("#dlg-timer").open')

        print('# 8. Tutup browser / reload tidak mereset')
        B.reload(); on_screen(B, 'unlock')
        check(B.is_visible('#screen-unlock'), 'setelah reload: minta password room lagi (kunci tidak disimpan)')
        unlock(B, ROOMPW); on_screen(B, 'chat'); wait_text(B, 'pesan saat B membaca atas')
        check(True, 'riwayat chat masih ada setelah reload')

        print('# 9. Sesi kedaluwarsa & pengambilalihan')
        # Simulasi perangkat A offline/tab ditangguhkan: heartbeat gagal terkirim, lalu sesi dianggap kedaluwarsa.
        A.route('**/api/rpc/heartbeat', lambda r: r.abort()); time.sleep(1.6)
        hit('/test/stale/usera')
        A2.reload(); on_screen(A2, 'login'); login(A2, 'usera', 'passA-12345'); on_screen(A2, 'unlock')
        check(True, 'sesi lama kedaluwarsa -> login dari perangkat baru diizinkan')
        A.unroute('**/api/rpc/heartbeat')
        A.wait_for_selector('#screen-login:not([hidden])', timeout=8000)
        check('tidak aktif' in A.inner_text('#login-err'), 'perangkat lama dikeluarkan dengan pesan jelas')
        unlock(A2, ROOMPW); on_screen(A2, 'chat'); wait_text(A2, 'pesan saat B membaca atas')

        print('# 10. Reset gagal lalu berhasil (logout)')
        hit('/test/failstorage/1')
        A2.click('#btn-logout'); A2.wait_for_selector('#dlg-logout[open]'); A2.click('#logout-confirm')
        A2.wait_for_selector('#logout-err:not([hidden])', timeout=8000)
        check(A2.is_visible('#screen-chat') and 'gagal' in A2.inner_text('#logout-err'), 'reset gagal: tidak mengaku berhasil dan tidak logout')
        B.wait_for_function('!document.querySelector("#banner").hidden && document.querySelector("#banner").textContent.includes("direset")', timeout=5000)
        check(B.locator('#list .msg').count() == 0 and B.is_disabled('#composer-input'), 'selama reset berjalan B tidak menampilkan/menerima chat')
        old_wrapped = dump()['secret']['wrapped']; old_epoch = dump()['state']['epoch']
        hit('/test/failstorage/0')
        A2.click('#logout-confirm'); on_screen(A2, 'login', 10000)
        check('dihapus' in A2.inner_text('#login-err'), 'logout berhasil kembali ke halaman login')
        check(A2.evaluate('localStorage.getItem("sb-mock-auth-token")') is None, 'token sesi dibersihkan dari perangkat')
        B.wait_for_function('!document.querySelector("#composer-input").disabled', timeout=8000)
        check(B.locator('#list .msg').count() == 0 and B.is_visible('#empty'), 'chat B langsung kosong setelah reset')
        d = dump()
        check(len(d['messages']) == 0 and len(d['storage']) == 0, 'semua pesan dan file di server terhapus')
        check(d['secret']['wrapped'] != old_wrapped and d['state']['epoch'] == old_epoch + 1 and d['state']['status'] == 'active', 'kunci room dirotasi & epoch naik')
        send(B, 'pesan setelah reset'); wait_text(B, 'pesan setelah reset')
        check(True, 'B tetap bisa mengirim memakai kunci baru')

        print('# 11. Login ulang: room hanya berisi pesan baru')
        login(A2, 'usera', 'passA-12345'); on_screen(A2, 'unlock'); unlock(A2, ROOMPW); on_screen(A2, 'chat')
        wait_text(A2, 'pesan setelah reset')
        check('pesan saat B membaca atas' not in texts(A2) and len(texts(A2)) == 1, 'pesan lama tidak bisa kembali; hanya pesan pasca-reset')
        send(A2, 'kita sudah sinkron'); wait_text(B, 'kita sinkron'.replace('kita sinkron', 'kita sudah sinkron'))
        check(True, 'chat dua arah berfungsi dengan kunci baru')

        print('# 12. Keluar tanpa membuka room (tanpa reset)')
        ctxC = br.new_context(); C = ctxC.new_page(); watch(C, 'C')
        A2.route('**/api/rpc/heartbeat', lambda r: r.abort()); time.sleep(1.6)
        hit('/test/stale/usera')
        C.goto(BASE + '/'); on_screen(C, 'login'); login(C, 'usera', 'passA-12345'); on_screen(C, 'unlock')
        C.click('#unlock-cancel'); on_screen(C, 'login')
        check(len(dump()['messages']) == 2, 'keluar dari halaman password room tidak menghapus chat')
        # A2 telah digantikan C -> terdeteksi
        A2.unroute('**/api/rpc/heartbeat')
        A2.wait_for_selector('#screen-login:not([hidden])', timeout=8000)
        check(True, 'A2 (sesi lama) keluar otomatis saat sesi diambil alih')

        br.close()
finally:
    srv.terminate()

print()
real = [e for e in errors]
if real:
    print('Pesan error browser:'); [print('  ', e) for e in real[:15]]
check(not any('pageerror' in e for e in errors), 'tidak ada exception JavaScript tak tertangani')
if fails:
    print(f'\n{len(fails)} pemeriksaan GAGAL'); sys.exit(1)
print('\nSemua pemeriksaan e2e lulus')
