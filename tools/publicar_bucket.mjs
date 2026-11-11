#!/usr/bin/env node
// [RT-1 · 11-nov] Publicacion de LevoPrint al bucket descargas/levoprint/ DESDE LA PC de Luis.
// El repo es publico: la llave de servicio NO va al CI. Este script la lee de la variable de
// entorno SUPABASE_SERVICE_KEY (cargada de un .env LOCAL, fuera de cualquier repo) y nunca la imprime.
//
// Uso (desde la raiz del repo):
//   gh run download <run_id_build-apk> -n LevoPrint-apk -D out/apk
//   gh run download <run_id_build-exe> -n LevoPrint-exe -D out/exe
//   node --env-file=C:\ruta\fuera\del\repo\.env tools/publicar_bucket.mjs out/apk out/exe
//   (agrega --seco para validar sin subir nada)
//
// Sube, si estan en las carpetas: LevoPrint.apk, luego LevoPrint.json (validado y alineado con
// app/build.gradle.kts; si es invalido no sube NADA) y LevoPrint-Windows.zip.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://krfljsososdakbatevci.supabase.co/storage/v1/object/descargas/levoprint/';
const args = process.argv.slice(2);
const seco = args.includes('--seco');
const dirs = args.filter((a) => a !== '--seco');
if (!dirs.length) { console.error('Uso: node tools/publicar_bucket.mjs <carpeta_artifact> [<carpeta_artifact>...] [--seco]'); process.exit(2); }

const buscar = (n) => dirs.map((d) => join(d, n)).find((p) => existsSync(p));
const apk = buscar('LevoPrint.apk');
const json = buscar('LevoPrint.json');
const zip = buscar('LevoPrint-Windows.zip');
if (!apk && !zip) { console.error('No hay LevoPrint.apk ni LevoPrint-Windows.zip en las carpetas.'); process.exit(1); }
if (apk && !json) { console.error('Hay APK pero falta su LevoPrint.json validado: no se publica nada.'); process.exit(1); }

// Misma validacion que el CI + que coincida con la version del codigo de esta copia.
if (json) {
  const j = JSON.parse(readFileSync(json, 'utf8'));
  const gradle = readFileSync('app/build.gradle.kts', 'utf8');
  const vc = Number((gradle.match(/versionCode *= *(\d+)/) || [])[1]);
  const vn = (gradle.match(/versionName *= *"([^"]+)"/) || [])[1];
  const ok = typeof j.versionCode === 'number' && j.versionCode > 0 && typeof j.versionName === 'string'
    && /^\d+\.\d+\.\d+$/.test(j.versionName) && typeof j.url === 'string'
    && j.url === BASE.replace('/object/', '/object/public/') + 'LevoPrint.apk' && typeof j.notas === 'string';
  if (!ok) { console.error('LevoPrint.json invalido: no se publica nada.'); process.exit(1); }
  if (j.versionCode !== vc || j.versionName !== vn) {
    console.error(`LevoPrint.json (${j.versionCode}/${j.versionName}) no coincide con app/build.gradle.kts (${vc}/${vn}): no se publica nada.`);
    process.exit(1);
  }
  console.log(`LevoPrint.json OK: ${j.versionName} (versionCode ${j.versionCode})`);
}

if (seco) { console.log('--seco: validado, no se sube nada.'); process.exit(0); }

const key = process.env.SUPABASE_SERVICE_KEY || '';
if (!key) { console.error('Falta SUPABASE_SERVICE_KEY en el entorno (usa --env-file con un .env FUERA del repo).'); process.exit(1); }

async function subir(ruta, nombre, tipo, extra = {}) {
  const r = await fetch(BASE + nombre, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'x-upsert': 'true', 'Content-Type': tipo, ...extra },
    body: readFileSync(ruta),
  });
  if (r.status !== 200) {
    const cuerpo = (await r.text()).slice(0, 300);
    throw new Error(`Fallo al subir ${nombre}: HTTP ${r.status} ${cuerpo}`);
  }
  console.log(`Publicado descargas/levoprint/${nombre}`);
}

try {
  // Orden: APK antes que su JSON (el aviso de actualizacion nunca apunta a un APK que aun no esta).
  if (apk) await subir(apk, 'LevoPrint.apk', 'application/vnd.android.package-archive');
  if (apk) await subir(json, 'LevoPrint.json', 'application/json', { 'Cache-Control': 'no-cache' });
  if (zip) await subir(zip, 'LevoPrint-Windows.zip', 'application/zip');
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
