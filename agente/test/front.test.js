// ============================================================
// LevoPrint F2 · el FRONT real (levodev-modules/core/front/lib/impresora.js)
// contra el agente real, sin navegador (Node trae fetch).
// Se carga impresora.js con sus imports cambiados por dobles: '@app/lib/api'
// (rpc de la app) y 'vue' (reactive). Lo de Chrome (permiso de red local,
// contenido mixto) NO se prueba aqui: eso exige un Android real.
// Guion: emparejar -> nube caida -> imprimir sale por la LAN (1 papel) ->
// vuelve la nube con el mismo jobId -> sin reimpresion -> interruptor apagado
// va por la nube -> agente apagado: cae a la nube -> equipo quitado en la
// ventana: la ruta local se apaga sola.
// Requiere el repo levodev-modules (LEVODEV_MODULES, por defecto la carpeta
// hermana C:/Users/ISO/levodev-modules); si no esta, se salta.
// ============================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { impresoraFalsa, nubeFalsa, puertoLibre, pedir, hasta, esperar } = require('./util/falsos');

const MODULOS = path.resolve(process.env.LEVODEV_MODULES || path.join(__dirname, '..', '..', '..', 'levodev-modules'));
const FUENTE = path.join(MODULOS, 'core', 'front', 'lib', 'impresora.js');
const hay = fs.existsSync(FUENTE);

async function cargarImpresora(dir, rpcFalso) {
  fs.writeFileSync(path.join(dir, 'vue.mjs'), 'export const reactive = (o) => o\n');
  fs.writeFileSync(path.join(dir, 'api.mjs'), 'export const rpc = (fn, p) => globalThis.__rpcFalso(fn, p)\n');
  fs.writeFileSync(path.join(dir, 'sesion.mjs'), "export const conToken = (o) => ({ ...o, token: 'tok' })\n");
  let src = fs.readFileSync(FUENTE, 'utf8').replace(/__PREFIX__/g, 'komo')
    .replace("from 'vue'", "from './vue.mjs'").replace("from '@app/lib/api'", "from './api.mjs'").replace("from '@app/lib/sesion'", "from './sesion.mjs'");
  fs.writeFileSync(path.join(dir, 'impresora.mjs'), src);
  fs.copyFileSync(path.join(MODULOS, 'core', 'front', 'lib', 'escpos.js'), path.join(dir, 'escpos.js'));
  globalThis.__rpcFalso = rpcFalso;
  return import(pathToFileURL(path.join(dir, 'impresora.mjs')).href);
}

test('front impresora.js + agente real: LAN primero, nube de respaldo, sin duplicados', { skip: !hay && 'sin levodev-modules', timeout: 90000 }, async (t) => {
  const cocina = await impresoraFalsa();
  const EST = crypto.randomUUID();
  const nube = await nubeFalsa({ prefijo: 'komo', estaciones: [{ id: EST, nombre: 'Cocina', ip: '127.0.0.1', puerto: cocina.puerto }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-front-'));
  const PG = await puertoLibre(), PL = await puertoLibre();
  const env = { LEVO_DIR: dir, LEVO_URL: nube.url, LEVO_ANON: 'x', LEVO_DEVICE: crypto.randomUUID(), LEVO_PREFIJO: 'komo', LEVO_SINVENTANA: '1', LEVO_PUERTO_GUI: String(PG), LEVO_PUERTO_LAN: String(PL), LEVO_TCP_PRUEBAS: '1', LEVO_LATIDO_MS: '1000' };
  let agente = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env: { ...process.env, ...env }, stdio: 'ignore' });
  t.after(async () => { try { agente.kill(); } catch { /* ya */ } await cocina.cerrar(); await nube.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await hasta(async () => (await pedir(PG, 'GET', '/estado').catch(() => ({}))).status === 200, 15000));
  const pin = (await pedir(PG, 'POST', '/lan/pin', { cuerpo: {} })).json.pin;   // abre el 9120 (MEDIO-3)
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/hola').catch(() => ({}))).status === 200, 15000));
  assert.ok(await hasta(() => nube.estado.llamadas.some((u) => u.endsWith('komo_agente_config')), 10000));

  const rpcs = [];
  const I = await cargarImpresora(dir, async (fn, p) => {
    rpcs.push(fn);
    if (fn === 'komo_print_local') return { ok: true, agentes: [{ ips: ['127.0.0.1'], puerto: PL }], estaciones: [{ id: EST, nombre: 'Cocina' }] };
    return { ok: true };
  });
  // nube de la app: encola en la nube falsa (como haria la RPC de la venta/comanda)
  const encoladosNube = [];
  const porNube = async (tr) => { if (nube.estado.caida) throw new Error('sin internet'); encoladosNube.push(tr.jobId); nube.encolar(tr.tipo, tr.estacion, tr.payload); return true; };

  // apagado por defecto: va DIRECTO a la nube, como hoy
  assert.equal(I.lpLocal.activo, false);
  const r0 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: { mesa: '1', items: [] } }, { nube: porNube });
  assert.equal(r0.via, 'NUBE');
  assert.ok(await hasta(() => cocina.papeles.length === 1, 15000), 'el papel de la nube salio');

  // emparejar con la direccion que publico el agente
  await I.refrescarDesdeNube();
  assert.deepEqual(I.basesSugeridas(), [`http://127.0.0.1:${PL}`]);
  // [re-QA NUEVO-1] una reimpresion siempre lleva un jobId NUEVO
  const pr = I.prepararReimpresion({ tipo: 'TICKET', estacion: EST, jobId: 'original-123456', payload: { a: 1 } });
  assert.notEqual(pr.jobId, 'original-123456');
  assert.deepEqual(pr.payload, { a: 1, reimpresion: true });

  // [QA BAJO] solo direcciones de la red del local
  assert.equal(I.normalizarBase('8.8.8.8'), '');
  assert.equal(I.normalizarBase('evil.com:9120'), '');
  assert.equal(I.normalizarBase('192.168.1.20'), 'http://192.168.1.20:9120');
  assert.equal(I.normalizarBase('caja.local'), 'http://caja.local:9120');
  await assert.rejects(I.emparejar(I.basesSugeridas()[0], '000000' === pin ? '111111' : '000000', 'Caja'), (e) => e.codigo === 'PIN_INVALIDO');
  await I.emparejar(I.basesSugeridas()[0], pin, 'Caja 1');
  assert.equal(I.lpLocal.activo, true);
  assert.ok(I.lpLocal.token.length > 20);

  // nube caida: sale por la LAN, un papel
  nube.estado.caida = true;
  const r1 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: { mesa: '7', items: [{ cantidad: 1, nombre: 'Ceviche' }] } }, { nube: porNube });
  assert.equal(r1.ok, true); assert.equal(r1.via, 'LAN');
  assert.ok(await hasta(() => cocina.papeles.length === 2, 3000));
  assert.match(cocina.textos()[1], /MESA 7[\s\S]*Ceviche/);

  // vuelve la nube y la bandeja sube la misma comanda (mismo jobId en el payload)
  nube.estado.caida = false;
  nube.encolar('COMANDA', EST, { mesa: '7', items: [{ cantidad: 1, nombre: 'Ceviche' }], jobId: r1.jobId });
  assert.ok(await hasta(() => nube.estado.marcados.length >= 2, 20000), 'la nube no recibio el marcar');
  await esperar(500);
  assert.equal(cocina.papeles.length, 2, 'la comanda NO salio dos veces');

  // interruptor apagado: por la nube
  I.activar(false);
  const r2 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: { mesa: '2', items: [] } }, { nube: porNube });
  assert.equal(r2.via, 'NUBE');
  assert.ok(encoladosNube.includes(r2.jobId));
  I.activar(true);

  // agente apagado: cae a la nube sin perder el papel
  agente.kill();
  await hasta(async () => !(await pedir(PL, 'GET', '/v1/hola').then(() => true, () => false)), 5000);
  const r3 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: { mesa: '3', items: [] } }, { nube: porNube });
  assert.equal(r3.via, 'NUBE');
  assert.ok(I.lpLocal.ultimoError);

  // sin agente y sin nube: no hay ruta (y lo dice)
  nube.estado.caida = true;
  const r4 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: {} }, { nube: porNube });
  assert.equal(r4.ok, false);
  nube.estado.caida = false;

  // [QA MEDIO-7] LevoPrint que acepta pero no contesta: dudoso:true y se sigue
  // a la nube con el MISMO jobId.
  const mudo = require('net').createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => mudo.once('listening', r));
  const guardado = { base: I.lpLocal.base, token: I.lpLocal.token };
  Object.assign(I.lpLocal, { base: 'http://127.0.0.1:' + mudo.address().port, token: 'x'.repeat(32), activo: true });
  const rD = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: {} }, { nube: porNube });
  assert.equal(rD.via, 'NUBE'); assert.equal(rD.dudoso, true);
  assert.ok(encoladosNube.includes(rD.jobId), 'la nube recibio el MISMO jobId');
  Object.assign(I.lpLocal, guardado);
  mudo.close();

  // el dueno quita el equipo en la ventana: la ruta local se apaga sola
  agente = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env: { ...process.env, ...env }, stdio: 'ignore' });
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/hola').catch(() => ({}))).status === 200, 15000));
  const eq = (await pedir(PG, 'GET', '/estado')).json.lan.equipos;
  // con un PIN vigente el 9120 sigue abierto (sin PIN ni equipos se cerraria: MEDIO-3)
  await pedir(PG, 'POST', '/lan/pin', { cuerpo: {} });
  await pedir(PG, 'POST', '/lan/quitar', { cuerpo: { id: eq[0].id } });
  const r5 = await I.imprimir({ tipo: 'COMANDA', estacion: EST, payload: {} }, { nube: porNube });
  assert.equal(r5.via, 'NUBE');
  assert.equal(I.lpLocal.activo, false);
  assert.equal(I.lpLocal.token, '');
  assert.ok(rpcs.includes('komo_print_local'));
});
