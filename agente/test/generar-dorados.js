// ============================================================
// Genera los dorados de render con el index.js ORIGINAL (commit b8b1517,
// antes del F2). Uso (una sola vez, o al cambiar el formato a propósito):
//   node test/generar-dorados.js
// Carga el index.js viejo en una carpeta temporal, sin arrancar el agente,
// y guarda el ESC/POS de cada fixture para 48 y 64 columnas.
// ============================================================
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REF = process.env.DORADO_REF || 'b8b1517';
const fuente = execFileSync('git', ['show', `${REF}:agente/index.js`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
const sinArranque = fuente.replace(/\narrancar\(\);\s*$/, '\nmodule.exports = { render };\n');
if (sinArranque === fuente) throw new Error('no encontre la llamada final a arrancar()');

const fixtures = require('./fixtures');
const destino = path.join(__dirname, 'dorados');
fs.mkdirSync(destino, { recursive: true });

for (const ancho of [48, 64]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-dorado-'));
  const archivo = path.join(tmp, 'index.js');
  fs.writeFileSync(archivo, sinArranque);
  process.env.LEVO_ANCHO = String(ancho);
  const m = new Module(archivo, module);
  m.filename = archivo;
  m.paths = Module._nodeModulePaths(tmp);
  const log = console.log, err = console.error;
  m._compile(sinArranque, archivo);
  console.log = log; console.error = err;   // el index viejo envuelve console: se restaura
  for (const f of fixtures) {
    const esc = m.exports.render(JSON.parse(JSON.stringify(f.job)));
    fs.writeFileSync(path.join(destino, `${f.nombre}.${ancho}.bin`), Buffer.from(esc, 'binary'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`dorados: ${fixtures.length * 2} archivos en ${destino}`);
