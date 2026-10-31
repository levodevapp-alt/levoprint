// ============================================================
// LevoPrint · empaqueta index.js + lib/*.js en UN archivo (F2)
// ------------------------------------------------------------
// PORQUE: el .exe es un Node SEA y en SEA el script principal solo puede
// hacer require() de modulos de Node (fs, net...), no de archivos sueltos.
// Desde F2 el agente esta partido en lib/ (para probar cada pieza); este
// paso los junta en dist/levoprint.bundle.js con un require propio, sin
// dependencias (nada de esbuild/webpack).
// Uso: node empaquetar.mjs   (build-exe.mjs lo llama solo)
// Verificacion: node dist/levoprint.bundle.js corre igual que node index.js.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const archivos = ['index.js', ...readdirSync(join(AQUI, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => 'lib/' + f)];

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

// Comprobacion barata de que las rutas relativas existen.
for (const rel of archivos) {
  const fuente = readFileSync(join(AQUI, rel), 'utf8');
  for (const m of fuente.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
    const k = posix.normalize(posix.join(posix.dirname(rel), m[1])).replace(/\.js$/, '');
    if (!archivos.includes(k + '.js')) throw new Error(`${rel}: require('${m[1]}') no existe en el paquete`);
  }
}

mkdirSync(join(AQUI, 'dist'), { recursive: true });
writeFileSync(join(AQUI, 'dist', 'levoprint.bundle.js'), salida);
console.log(`empaquetado: ${archivos.length} archivos -> dist/levoprint.bundle.js (${(salida.length / 1024).toFixed(0)} KB)`);
