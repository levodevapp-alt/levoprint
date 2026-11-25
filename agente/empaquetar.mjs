// ============================================================
// LevoPrint · empaqueta index.js + lib/*.js en UN archivo (LP-O02, de F2)
// ------------------------------------------------------------
// PORQUE: el .exe es un Node SEA y en SEA el script principal solo puede
// hacer require() de modulos de Node (fs, net...), no de archivos sueltos.
// Desde LP-O02 el agente tiene lib/ (servidor LAN, emparejar, diario); este
// paso los junta en dist/levoprint.bundle.js con un require propio, sin
// dependencias (nada de esbuild/webpack).
// Uso: node empaquetar.mjs   (build-exe.mjs lo llama solo)
// Verificacion: node dist/levoprint.bundle.js corre igual que node index.js
// (prueba_lan.cjs comprueba que el paquete carga los tres modulos).
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { createRequire } from 'node:module';

const AQUI = dirname(fileURLToPath(import.meta.url));

// [RCA · 25-nov] Candado del render común: lib/render_comun.js tiene que ser la conversión EXACTA de
// render_comun/render.mjs y ese archivo el de render_comun/ORIGEN.json (sha256 de levodev-modules
// core/print/render.mjs). Si algo no cuadra, NO se arma el paquete (ni el .exe): un render tocado a mano
// volvería a imprimir distinto de la Edge.
{
  const { verificar } = createRequire(import.meta.url)('../render_comun/convertir.cjs');
  const v = verificar();
  if (!v.ok) {
    for (const e of v.errores) console.error('render común: ' + e);
    throw new Error('empaquetado detenido: el render común no cuadra con su hash (render_comun/ORIGEN.json)');
  }
  console.log('render común verificado: sha256 ' + v.origen.sha256_render.slice(0, 12) + ' (' + v.origen.fixtures + ' fixtures)');
}

const archivos =['index.js', ...readdirSync(join(AQUI, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => 'lib/' + f)];

// Comprobacion barata de que las rutas relativas existen (antes de escribir nada).
for (const rel of archivos) {
  const fuente = readFileSync(join(AQUI, rel), 'utf8');
  for (const m of fuente.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
    const k = posix.normalize(posix.join(posix.dirname(rel), m[1])).replace(/\.js$/, '');
    if (!archivos.includes(k + '.js')) throw new Error(`${rel}: require('${m[1]}') no existe en el paquete`);
  }
}

const clave = (rel) => rel.replace(/\.js$/, '');
let salida = `// LevoPrint · agente empaquetado (generado por empaquetar.mjs; NO editar)\n'use strict';\n`;
salida += `const __lpModulos = Object.create(null);\nconst __lpCache = Object.create(null);\n`;
salida += `function __lpRequire(desde, spec) {\n`
  + `  if (spec.startsWith('./') || spec.startsWith('../')) {\n`
  + `    const k = __lpNormal(desde, spec);\n`
  + `    if (!__lpModulos[k]) throw new Error('empaquetado: falta el modulo ' + k);\n`
  + `    if (!__lpCache[k]) { const m = { exports: {} }; __lpCache[k] = m; __lpModulos[k](m, m.exports, (s) => __lpRequire(__lpDir(k), s)); }\n`
  + `    return __lpCache[k].exports;\n`
  + `  }\n`
  + `  return require(spec);\n`
  + `}\n`;
salida += `function __lpDir(k) { const i = k.lastIndexOf('/'); return i < 0 ? '.' : k.slice(0, i); }\n`;
salida += `function __lpNormal(dir, spec) {\n  const partes = (dir === '.' ? [] : dir.split('/'));\n  for (const p of spec.replace(/\\.js$/, '').split('/')) { if (p === '.' || !p) continue; if (p === '..') partes.pop(); else partes.push(p); }\n  return partes.join('/');\n}\n`;

for (const rel of archivos) {
  const fuente = readFileSync(join(AQUI, rel), 'utf8').replace(/^#!.*\n/, '');
  salida += `\n// ===== ${rel} =====\n__lpModulos[${JSON.stringify(clave(rel))}] = function (module, exports, require) {\n${fuente}\n};\n`;
}
// Arranque: index.js es el principal.
salida += `\n{ const m = { exports: {} }; __lpCache['index'] = m; __lpModulos['index'](m, m.exports, (s) => __lpRequire('.', s)); }\n`;

mkdirSync(join(AQUI, 'dist'), { recursive: true });
writeFileSync(join(AQUI, 'dist', 'levoprint.bundle.js'), salida);
console.log(`empaquetado: ${archivos.length} archivos -> dist/levoprint.bundle.js (${(salida.length / 1024).toFixed(0)} KB)`);
