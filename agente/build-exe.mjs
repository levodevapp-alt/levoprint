// ============================================================
// KOMO · build del agente a LevoPrint.exe (Node SEA)  ⚡ by Levo.dev
// Uso:  node build-exe.mjs
// Requiere Node >= 20 (Single Executable Applications).
// Produce dist/LevoPrint.exe (autonomo, sin Node instalado).
// ============================================================
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const salida = join(AQUI, 'dist', 'LevoPrint.exe');

console.log('1/3  Generando el blob SEA...');
execFileSync(process.execPath, ['--experimental-sea-config', join(AQUI, 'sea-config.json')], { stdio: 'inherit', cwd: AQUI });

console.log('2/3  Copiando el runtime de Node...');
mkdirSync(join(AQUI, 'dist'), { recursive: true });
copyFileSync(process.execPath, salida);

console.log('3/3  Inyectando el blob en el .exe...');
execFileSync(process.execPath, [
  join(AQUI, 'node_modules', 'postject', 'dist', 'cli.js'),  // CLI real (multiplataforma)
  salida, 'NODE_SEA_BLOB', join(AQUI, 'sea-prep.blob'), '--sentinel-fuse', FUSE
], { stdio: 'inherit', cwd: AQUI });

try { rmSync(join(AQUI, 'sea-prep.blob')); } catch { /* nada */ }
console.log(`\nListo -> ${salida}  (${(statSync(salida).size / 1e6).toFixed(0)} MB)`);
