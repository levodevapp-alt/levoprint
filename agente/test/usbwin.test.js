// ============================================================
// USB en Windows por la cola de impresion (RAW), contra el spooler REAL.
// Sin ticketera a mano se usa "Microsoft Print to PDF" con salida a archivo
// (DOC_INFO_1.pOutputFile, sin dialogo): prueba que el helper compila, que
// OpenPrinter/StartDocPrinter(RAW)/WritePrinter aceptan los bytes y que la
// cola queda limpia. El driver PDF descarta el RAW (el archivo sale vacio):
// el papel real se prueba a mano con la ticketera (docs/F2_IMPRESION_LOCAL.md §5).
// Solo corre en Windows y con LP_USB=1 (abre PowerShell, ~2 s).
// ============================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const usbwin = require('../lib/usbwin');
const { buscarTodo } = require('../lib/buscar');

const correr = process.platform === 'win32' && process.env.LP_USB === '1';

test('Windows: el script va por stdin (sin .ps1 ni Bypass) y el hijo recibe un entorno minimo', { skip: !correr }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ps-'));
  fs.writeFileSync(path.join(dir, 'levoprint-raw.ps1'), 'viejo');           // lo dejaba una version anterior
  usbwin.configurar(dir);
  assert.ok(!fs.existsSync(path.join(dir, 'levoprint-raw.ps1')), 'se borra el .ps1 viejo');
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usbwin.js'), 'utf8');
  assert.ok(!/'-ExecutionPolicy', 'Bypass'/.test(fuente) && !/'-File'/.test(fuente) && /'-Command', '-'/.test(fuente));
  const env = usbwin.entornoMinimo({ LP_X: '1' });
  assert.ok(!('LEVO_ANON' in env) && !('LEVO_DEVICE' in env) && env.LP_X === '1' && env.PATH);
  assert.ok((await usbwin.listar()).length >= 1, 'corre desde la carpeta configurada');
});

test('Windows: listar impresoras (Get-Printer) y clasificarlas', { skip: !correr }, async () => {
  const lista = await usbwin.listar();
  assert.ok(Array.isArray(lista) && lista.length >= 1, 'Windows siempre trae al menos una');
  for (const p of lista) assert.ok(p.nombre && p.via, JSON.stringify(p));
});

test('Windows: RAW por el spooler a Microsoft Print to PDF', { skip: !correr }, async () => {
  const lista = await usbwin.listar();
  const pdf = lista.find((p) => /Microsoft Print to PDF/i.test(p.nombre));
  if (!pdf) return test.skip?.('sin Microsoft Print to PDF');
  const salida = path.join(os.tmpdir(), 'levoprint-raw-' + Date.now() + '.pdf');
  const n = await usbwin.imprimir(pdf.nombre, Buffer.from('\x1b@PRUEBA LEVOPRINT RAW\n\n\x1dV\x00', 'binary'), { archivoSalida: salida, timeoutMs: 30000 });
  assert.equal(n, 27);
  try { fs.unlinkSync(salida); } catch { /* el driver puede no crearlo */ }
});

test('Windows: impresora inexistente da un error claro', { skip: !correr }, async () => {
  // [QA MEDIO-1] no se pudo abrir la impresora: seguro que no salio nada (sinEnviar)
  await assert.rejects(usbwin.imprimir('No Existe LevoPrint 123', Buffer.from('x')), (e) => /OpenPrinter|1801|no es v|invalid/i.test(e.message) && e.sinEnviar === true);
  // [QA MEDIO-5] el .bin temporal se borra aunque falle
  assert.deepEqual(fs.readdirSync(usbwin.DIR_TMP).filter((f) => f.endsWith('.bin')), []);
});

test('Windows: el asistente no ofrece impresoras virtuales (PDF, fax)', { skip: !correr }, async () => {
  const r = await buscarTodo({ lan: false, mdns: false });
  assert.ok(r.ok);
  assert.ok(!r.impresoras.some((h) => /Print to PDF|Fax|OneNote/i.test(h.nombre)));
});
