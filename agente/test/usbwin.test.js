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
  await assert.rejects(usbwin.imprimir('No Existe LevoPrint 123', Buffer.from('x')), /OpenPrinter|1801|no es v|invalid/i);
});

test('Windows: el asistente no ofrece impresoras virtuales (PDF, fax)', { skip: !correr }, async () => {
  const r = await buscarTodo({ lan: false, mdns: false });
  assert.ok(r.ok);
  assert.ok(!r.impresoras.some((h) => /Print to PDF|Fax|OneNote/i.test(h.nombre)));
});
