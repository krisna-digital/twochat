// Memeriksa sintaks semua modul JS dan Edge Function TypeScript (tanpa menjalankan). Butuh Node >= 22.6.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => ['js/' + f, []]);
for (const fn of ['reset-room', 'cleanup']) files.push([`supabase/functions/${fn}/index.ts`, ['--experimental-strip-types']]);

let bad = 0;
for (const [path, flags] of files) {
  try { execFileSync(process.execPath, [...flags, '--check', path], { stdio: 'pipe' }); console.log('  ok  ' + path); }
  catch (e) { bad++; console.log('GAGAL ' + path + '\n' + String(e.stderr).split('\n').slice(0, 6).join('\n')); }
}
if (bad) { console.log(bad + ' file bermasalah'); process.exit(1); }
console.log('Semua sintaks valid');
