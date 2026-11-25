// ============================================================
// LevoPrint · pruebas de LP-O02: imprimir sin internet por la red del local
// ------------------------------------------------------------
//   node agente/prueba_lan.cjs        (va en `npm run prueba`)
// Sin dependencias, sin Supabase ni impresoras reales:
//   A) lib/diario.js      duplicado, ENVIANDO a medias, DUDOSO/FALLO, retención, archivo corrupto, candado,
//                         registrado/rechazado por (clave, estación), orden y tope de envíos a agente_lan
//   B) lib/emparejar.js   PIN de 3 min solo tras «Emparejar equipo», PIN_VENCIDO, fallos por IP, anulación + bloqueo
//                         10 min + «Otro PIN», goteo de 7 días con reloj simulado → BLOQUEADO acumulado (en disco,
//                         sobrevive a reiniciar), token vencido, quitar, archivo
//   C) lib/servidorLan.js IP pública/CGNAT, Host, Origin/CORS, preflight PNA, tope de cuerpo, 423, puertos
//   D) agente completo    (index.js + lib en una carpeta temporal, mock_rpc.cjs, impresora TCP falsa en
//                          127.0.0.1): ventana → PIN → emparejar → imprimir → YA_IMPRESO → OTRO_EQUIPO →
//                          trabajo de la nube con el mismo jobId no se repite → agente_lan → reinicio SIN
//                          red imprime con las rutas del disco → quitar equipo → apagar el interruptor
//   E) paquete del .exe   empaquetar.mjs junta index.js + lib y el paquete arranca (versión de package.json)
// ============================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { Diario, claveDe, claveDeNube, jobIdValido, MAX_ENVIOS_LAN } = require('./lib/diario');
const { Emparejador, VIDA_TOKEN_MS, PIN_MS, FALLOS_POR_PIN, BLOQUEO_PIN_MS } = require('./lib/emparejar');
const lanRed = require('./lib/servidorLan');
const { crearMock } = require('./mock_rpc.cjs');

const VERSION = require('./package.json').version;
let fallas = 0, oks = 0;
const ok = (c, m, det) => {
  console.log((c ? 'OK    ' : 'FALLA ') + m + (c || det === undefined ? '' : '\n      ' + String(typeof det === 'string' ? det : JSON.stringify(det)).slice(0, 800)));
  if (c) oks++; else fallas++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms, paso) {
  const fin = Date.now() + ms;
  for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() > fin) return null; await espera(paso || 150); }
}
function puertoLibre() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// Bloque de 5 puertos libres seguidos (ventana 9110-9114 y LAN 9120-9124 de prueba).
async function bloqueLibre() {
  for (let i = 0; i < 200; i++) {
    const base = 30000 + Math.floor(Math.random() * 3000) * 10;
    let libres = true;
    for (let k = 0; k < 5 && libres; k++) {
      libres = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(base + k, '127.0.0.1', () => s.close(() => r(true))); });
    }
    if (libres) return base;
  }
  throw new Error('no hay puertos libres');
}
function impresora(host, puerto) {
  const recibido = [];
  const s = net.createServer((c) => { const partes = []; c.on('data', (d) => partes.push(d)); c.on('end', () => { if (partes.length) recibido.push(Buffer.concat(partes).toString('latin1')); }); c.on('error', () => {}); });
  return new Promise((resolve, reject) => { s.once('error', reject); s.listen(puerto, host, () => resolve({ s, recibido })); });
}
// http crudo: fetch no deja cambiar Host ni manda OPTIONS a mano.
function pedir(base, ruta, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  return new Promise((resolve) => {
    const u = new URL(base + ruta);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers, agent: false }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { j = null; } resolve({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, headers: {}, error: e.code }));
    if (o.body !== undefined) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}
const tmpRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'levoprint-lan-'));
const tmp = (n) => { const d = path.join(tmpRaiz, n); fs.mkdirSync(d, { recursive: true }); return d; };

// ---------------------------------------------------------------- A) diario
async function pruebaDiario() {
  console.log('\n-- A) diario --');
  const dir = tmp('diario');
  const archivo = path.join(dir, 'd.jsonl');
  let reloj = Date.parse('2026-11-20T12:00:00Z');
  const d = new Diario(archivo, { ahora: () => reloj });
  const enviados = [];
  const op = (jobId, est, extra) => Object.assign({
    clave: claveDe(jobId, est), jobId, estacion: est, prefijo: 'komo', origen: 'LAN', tipo: 'COMANDA',
    render: async (reimp) => (reimp ? 'REIMPRESION ' : '') + 'papel ' + jobId,
    enviar: async (t) => { enviados.push(t); },
  }, extra || {});

  let r = await d.procesar(op('job-aaaa-1', 'e1'));
  ok(r.estado === 'IMPRESO' && enviados.length === 1, 'primer papel: IMPRESO', r);
  r = await d.procesar(op('job-aaaa-1', 'e1'));
  ok(r.estado === 'YA_IMPRESO' && enviados.length === 1, 'mismo jobId y estación: YA_IMPRESO sin imprimir', r);
  r = await d.procesar(op('job-aaaa-1', 'e2'));
  ok(r.estado === 'IMPRESO' && enviados.length === 2, 'mismo jobId en OTRA estación: es otro papel (sale)', r);

  // Falla a mitad del envío (dudoso) → DUDOSO; el reintento sale con sello.
  let lanzado = null;
  try { await d.procesar(op('job-dudoso', 'e1', { enviar: async () => { const e = new Error('reset'); e.dudoso = true; throw e; } })); } catch (e) { lanzado = e; }
  ok(!!lanzado && lanzado.estadoDiario === 'DUDOSO' && d.estado(claveDe('job-dudoso', 'e1')) === 'DUDOSO', 'falla después de conectar → DUDOSO', lanzado && lanzado.estadoDiario);
  r = await d.procesar(op('job-dudoso', 'e1'));
  ok(r.estado === 'IMPRESO' && r.reimpresion === true && enviados[enviados.length - 1].startsWith('REIMPRESION'), 'reintento de un DUDOSO sale con sello REIMPRESION', r);

  // Falla sin mandar nada → FALLO; el reintento sale normal.
  lanzado = null;
  try { await d.procesar(op('job-fallo', 'e1', { enviar: async () => { throw new Error('ECONNREFUSED'); } })); } catch (e) { lanzado = e; }
  ok(!!lanzado && lanzado.estadoDiario === 'FALLO', 'conexión rechazada → FALLO', lanzado && lanzado.estadoDiario);
  r = await d.procesar(op('job-fallo', 'e1'));
  ok(r.estado === 'IMPRESO' && !r.reimpresion && !enviados[enviados.length - 1].startsWith('REIMPRESION'), 'reintento de un FALLO sale normal (sin sello)', r);

  // Render que falla: el diario no cambia.
  lanzado = null;
  try { await d.procesar(op('job-render', 'e1', { render: async () => { throw new Error('render'); } })); } catch (e) { lanzado = e; }
  ok(!!lanzado && !lanzado.estadoDiario && d.estado(claveDe('job-render', 'e1')) === null, 'render que falla no deja rastro en el diario');

  // Dos pedidos a la vez con la misma clave (la app reintenta mientras imprime): sale UNO.
  let n = 0;
  const lento = op('job-carrera', 'e1', { enviar: async () => { n++; await espera(80); } });
  const [a, b] = await Promise.all([d.procesar(lento), d.procesar(lento)]);
  ok(n === 1 && [a.estado, b.estado].sort().join(',') === 'IMPRESO,YA_IMPRESO', 'dos pedidos simultáneos con la misma clave: un solo papel', [a, b, n]);

  // Se cortó la luz con el papel ENVIANDO → al reabrir queda DUDOSO.
  d.poner(claveDe('job-corte', 'e1'), { j: 'job-corte', est: 'e1', p: 'komo', o: 'LAN', e: 'ENVIANDO' });
  const d2 = new Diario(archivo, { ahora: () => reloj });
  ok(d2.estado(claveDe('job-corte', 'e1')) === 'DUDOSO', 'ENVIANDO al reabrir → DUDOSO');
  ok(d2.estado(claveDe('job-aaaa-1', 'e1')) === 'IMPRESO', 'lo IMPRESO sobrevive al reinicio (disco)');
  r = await d2.procesar(op('job-corte', 'e1'));
  ok(r.estado === 'IMPRESO' && r.reimpresion === true, 'el papel cortado a medias sale con sello REIMPRESION', r);

  // Reportar a la nube: solo IMPRESO por la LAN, de esa app, sin reportar.
  d2.poner(claveDe('job-nube-x', 'e1'), { j: 'job-nube-x', est: 'e1', p: 'komo', o: 'NUBE', e: 'IMPRESO' });
  d2.poner(claveDe('job-kipu-x', 'k1'), { j: 'job-kipu-x', est: 'k1', p: 'kipu', o: 'LAN', e: 'IMPRESO' });
  const pend = d2.sinReportar('komo');
  ok(pend.length >= 3 && pend.every((x) => x.clave.startsWith('job-') && x.clave !== 'job-nube-x' && x.clave !== 'job-kipu-x') && !pend.some((x) => x.clave === 'job-fallo' && false), 'sinReportar: solo IMPRESO por la LAN de esa app', pend.map((x) => x.clave));
  const marcados = d2.marcarReportados(pend, [pend[0].clave]);
  ok(marcados >= 1 && d2.sinReportar('komo').length === pend.length - marcados, 'marcarReportados quita de la lista lo que la nube registró', { marcados, antes: pend.length });

  // [QA MEDIO-1] Registrado / rechazado POR (clave, estación), orden y tope de envíos.
  let relojR = reloj;
  const dr = new Diario(path.join(dir, 'rech.jsonl'), { ahora: () => relojR });
  const imprLan = (j, est) => { relojR += 1000; dr.poner(claveDe(j, est), { j, est, p: 'komo', o: 'LAN', e: 'IMPRESO' }); };
  imprLan('job-viejo-1', 'e1'); imprLan('job-dual-1', 'e1'); imprLan('job-dual-1', 'e2'); imprLan('job-nuevo-1', 'e1');
  let lote = dr.sinReportar('komo', 2);
  ok(lote.length === 2 && lote[0].clave === 'job-nuevo-1' && lote[1].clave === 'job-dual-1' && lote[1].estacion === 'e2', 'sinReportar: lo más reciente primero (la basura vieja no tapa lo nuevo)', lote.map((x) => x.clave + '|' + x.estacion));
  lote = dr.sinReportar('komo');
  let c = dr.marcarRespuesta(lote, {
    registrados: ['job-dual-1', 'job-nuevo-1'], rechazados: ['job-dual-1'],
    registrados_det: [{ clave: 'job-dual-1', estacion: 'e1' }, ['job-nuevo-1', 'e1']],
    rechazados_det: [{ clave: 'job-dual-1', estacion: 'e2', motivo: 'ESTACION_AJENA' }],
  });
  ok(c.registrados === 2 && c.rechazados === 1 && dr.get(claveDe('job-dual-1', 'e1')).r === true && dr.get(claveDe('job-dual-1', 'e2')).r === 'rechazado',
    'detalle por estación: el mismo jobId queda registrado en e1 y rechazado en e2', c);
  ok(JSON.stringify(dr.sinReportar('komo').map((x) => x.clave)) === '["job-viejo-1"]', 'lo registrado y lo rechazado salen de sinReportar (lo rechazado no se reenvía)', dr.sinReportar('komo'));
  const drB = new Diario(path.join(dir, 'rech.jsonl'), { ahora: () => relojR });
  ok(drB.get(claveDe('job-dual-1', 'e2')).r === 'rechazado' && drB.sinReportar('komo').length === 1, 'la marca «rechazado» sobrevive al reinicio');

  // Forma compatible (solo claves): aplica a todas las filas de ESE lote con la clave, no a las de fuera.
  imprLan('job-lista-1', 'e1'); imprLan('job-lista-1', 'e2');
  const loteL = dr.sinReportar('komo').filter((x) => x.clave === 'job-lista-1' && x.estacion === 'e1');
  c = dr.marcarRespuesta(loteL, { registrados: [], rechazados: ['job-lista-1'] });
  ok(c.rechazados === 1 && dr.get(claveDe('job-lista-1', 'e1')).r === 'rechazado' && !dr.get(claveDe('job-lista-1', 'e2')).r,
    'solo claves: marca las filas del lote con esa clave; la misma clave fuera del lote sigue pendiente', c);

  // Tope de envíos sin respuesta útil.
  imprLan('job-tope-1', 'e1');
  const unoTope = () => dr.sinReportar('komo').filter((x) => x.clave === 'job-tope-1');
  for (let i = 0; i < MAX_ENVIOS_LAN - 1; i++) dr.marcarRespuesta(unoTope(), {});
  ok(unoTope().length === 1, (MAX_ENVIOS_LAN - 1) + ' envíos sin respuesta: aún se manda');
  c = dr.marcarRespuesta(unoTope(), { ok: true, registrados: ['otro'] });
  ok(c.agotados === 1 && unoTope().length === 0 && !dr.get(claveDe('job-tope-1', 'e1')).r, 'al envío ' + MAX_ENVIOS_LAN + ' sin respuesta útil deja de mandarse (sin marcarlo registrado)', c);

  // Retención 7 días.
  const d3 = new Diario(archivo, { ahora: () => reloj + 6 * 86400000 });
  ok(d3.estado(claveDe('job-aaaa-1', 'e1')) === 'IMPRESO', 'a los 6 días el papel sigue en el diario');
  const d4 = new Diario(archivo, { ahora: () => reloj + 8 * 86400000 });
  ok(d4.mapa.size === 0, 'a los 8 días el diario se purga (retención 7 días)', d4.mapa.size);

  // Archivo corrupto: basura, una línea cortada y una buena.
  const arch2 = path.join(dir, 'roto.jsonl');
  const buena = JSON.stringify({ k: 'job-bueno|e1', j: 'job-bueno', est: 'e1', e: 'IMPRESO', ts: reloj });
  fs.writeFileSync(arch2, '\u0000ÿ basura{{{\n' + buena + '\n{"k":"job-cort');
  let d5 = null, err5 = null;
  try { d5 = new Diario(arch2, { ahora: () => reloj }); } catch (e) { err5 = e; }
  ok(!err5 && d5.estado('job-bueno|e1') === 'IMPRESO' && d5.lineasMalas === 2, 'archivo corrupto: se ignoran las líneas malas y se conserva la buena', { err5: err5 && err5.message, malas: d5 && d5.lineasMalas });
  ok(fs.readFileSync(arch2, 'utf8').trim() === buena, 'al compactar queda solo lo legible (escritura atómica)');
  fs.writeFileSync(arch2, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]));
  let d6 = null; try { d6 = new Diario(arch2); } catch { d6 = null; }
  ok(!!d6 && d6.mapa.size === 0, 'archivo binario ilegible: diario vacío, el agente no se cae');

  // Claves de la nube.
  const c1 = claveDeNube('komo', { id: 55, estacion: 'e1', tipo: 'COMANDA', payload: { jobId: 'ck-1234:e1' } });
  const c2 = claveDeNube('komo', { id: 55, estacion: 'e1', tipo: 'COMANDA', payload: {} });
  const c1b = claveDeNube('komo', { id: 56, estacion: 'e1', tipo: 'PRECUENTA', payload: { jobId: 'ck-1234:e1' } });
  ok(c1.clave === 'ck-1234:e1|e1' && c1b.clave === 'ck-1234:e1|e1' && c2.clave === 'nube:komo:55|e1', 'clave de la nube: payload.jobId|estación (COMANDA/PRECUENTA) o nube:<app>:<id>', [c1, c1b, c2]);
  const cT = ['TICKET', 'CPE', 'CIERRE', 'TURNO', undefined].map((tipo) => claveDeNube('komo', { id: 57, estacion: 'e1', tipo, payload: { jobId: 'ck-1234:e1' } }).clave);
  ok(cT.every((k) => k === 'nube:komo:57|e1'), '[QA MEDIO-2] TICKET/CPE/CIERRE/TURNO de la nube no se cruzan por payload.jobId (clave = id de la nube)', cT);
  ok(jobIdValido('5b0c8a1e-3f9e-4b4e-9b0a-0f6d4c1e2a77:2a1b0c8a-3f9e-4b4e-9b0a-0f6d4c1e2a77') && !jobIdValido('nube:komo:1') && !jobIdValido('corto') && !jobIdValido('con espacio 123'), 'jobIdValido acepta clienteKey:estación y rechaza lo raro');
}

// ---------------------------------------------------------------- B) emparejar
function pruebaEmparejar() {
  console.log('\n-- B) emparejar --');
  const archivo = path.join(tmp('emparejar'), 'equipos.json');
  let reloj = Date.parse('2026-11-20T12:00:00Z');
  const em = new Emparejador(archivo, { ahora: () => reloj });
  ok(em.pinVigente() === null, 'sin pulsar «Emparejar equipo» no hay PIN');
  let r = em.intentar('123456', 'Caja', '192.168.1.20');
  ok(r.ok === false && r.error === 'SIN_PIN', 'sin PIN: SIN_PIN', r);
  const pin = em.pedirPin().pin.valor;
  ok(/^\d{6}$/.test(pin), 'PIN de 6 dígitos', pin);
  const malo = pin === '000000' ? '111111' : '000000';
  r = em.intentar(malo, 'Caja', '192.168.1.20');
  ok(r.ok === false && r.error === 'PIN_INVALIDO', 'PIN errado: PIN_INVALIDO', r);
  for (let i = 0; i < 4; i++) r = em.intentar(malo, 'Caja', '192.168.1.20');
  r = em.intentar(pin, 'Caja', '192.168.1.20');
  ok(r.ok === false && r.error === 'ESPERA', '5 fallos desde una IP: esa IP espera aunque ahora acierte', r);
  r = em.intentar(pin, 'Caja <script>', '192.168.1.21');
  ok(r.ok === true && typeof r.token === 'string' && r.token.length >= 40 && !isNaN(Date.parse(r.vence)), 'otra IP con el PIN bueno: token y vence', r);
  ok(r.equipo.nombre === 'Caja script', 'el nombre del equipo se limpia', r.equipo);
  const token = r.token;
  ok(Math.abs(Date.parse(r.vence) - (reloj + VIDA_TOKEN_MS)) < 1000, 'el token vence a los 90 días');
  r = em.intentar(pin, 'Mozo', '192.168.1.22');
  ok(r.ok === false && r.error === 'SIN_PIN', 'el PIN sirve una sola vez', r);
  ok(!fs.readFileSync(archivo, 'utf8').includes(token), 'en disco no queda el token (solo su sha256)');
  ok(!!em.validar(token) && !em.validar(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), 'validar: el token bueno sí, uno alterado no');
  const em2 = new Emparejador(archivo, { ahora: () => reloj });
  ok(!!em2.validar(token), 'tras reiniciar el agente el equipo sigue emparejado');

  // [QA MEDIO-1] El PIN vale 3 min y no se regenera solo.
  ok(PIN_MS === 3 * 60000, 'el PIN vale 3 minutos', PIN_MS);
  const p1 = em.pedirPin().pin.valor;
  reloj += PIN_MS - 5000;
  ok(em.pinVigente() !== null && em.pinVigente().valor === p1, 'a los 2:55 el PIN sigue vivo');
  reloj += 6000;
  ok(em.pinVigente() === null && em.pinVigente() === null, 'a los 3 min el PIN vence y NO se genera otro solo');
  r = em.intentar(p1, 'Caja', '192.168.1.30');
  ok(r.ok === false && r.error === 'PIN_VENCIDO', 'PIN vencido: PIN_VENCIDO (ni el bueno sirve)', r);
  const pa = em.pedirPin().pin.valor, pb = em.pedirPin().pin.valor;
  ok(em.pinVigente().valor === pb && (pa === pb || em.intentar(pa, 'x', '192.168.1.31').error === 'PIN_INVALIDO'), 'uno a la vez: pedir otro reemplaza al anterior');
  em.anularPin();
  ok(em.intentar(pb, 'x', '192.168.1.32').error === 'SIN_PIN', 'apagar el interruptor mata el PIN (SIN_PIN)');
  em.fallos = []; em.porIp.clear(); em.guardar();   // limpio para lo que sigue

  // Anulación tras N fallos acumulados (de muchas IP, respetando el tope por minuto).
  const p2 = em.pedirPin().pin.valor;
  const otro = p2 === '999999' ? '888888' : '999999';
  let ult = null;
  for (let i = 0; i < FALLOS_POR_PIN; i++) {
    if (i && i % 25 === 0) reloj += 61000;
    ult = em.intentar(otro, 'x', '10.0.' + Math.floor(i / 4) + '.' + (i % 4 + 1));
  }
  ok(ult && ult.error === 'PIN_ANULADO' && em.pinVigente() === null, FALLOS_POR_PIN + ' fallos acumulados anulan el PIN', ult);
  // [QA MEDIO-3] Bloqueo de 10 min y luego «Otro PIN» a mano (no se regenera solo).
  ok(em.pinVigente() === null && em.estadoBloqueo().bloqueado === true, 'tras PIN_ANULADO no hay PIN', em.estadoBloqueo());
  r = em.pedirPin();
  ok(r.ok === false && r.error === 'PIN_BLOQUEADO' && em.pinVigente() === null, '«Emparejar equipo» con el bloqueo puesto: se niega (solo «Otro PIN» lo levanta)', r);
  r = em.intentar(p2, 'x', '192.168.7.7');
  ok(r.ok === false && r.error === 'PIN_BLOQUEADO' && r.esperaS > 0, 'bloqueado: ni el PIN viejo ni otro sirven (PIN_BLOQUEADO)', r);
  r = em.pedirOtroPin();
  ok(r.ok === false && r.error === 'PIN_BLOQUEADO' && r.esperaS > 0 && r.esperaS <= BLOQUEO_PIN_MS / 1000, '«Otro PIN» durante los 10 min: se niega', r);
  em.anularPin();   // apagar y encender el interruptor tampoco lo destraba
  ok(em.pinVigente() === null && em.estadoBloqueo().bloqueado === true, 'apagar/encender el interruptor no destraba el bloqueo');
  const emR = new Emparejador(archivo, { ahora: () => reloj });
  ok(emR.estadoBloqueo().bloqueado === true && emR.estadoBloqueo().esperaS > 0, 'el bloqueo de 10 min sobrevive a reiniciar LevoPrint (disco)', emR.estadoBloqueo());
  reloj += BLOQUEO_PIN_MS + 1000;
  ok(em.pinVigente() === null && em.estadoBloqueo().requiereOtroPin === true && em.estadoBloqueo().esperaS === 0, 'pasados 10 min sigue sin PIN hasta pulsar «Otro PIN»', em.estadoBloqueo());
  r = em.intentar('123456', 'x', '192.168.7.8');
  ok(r.error === 'PIN_BLOQUEADO', 'pasados 10 min, emparejar sigue bloqueado sin «Otro PIN»', r);
  r = em.pedirOtroPin();
  ok(r.ok === true && /^\d{6}$/.test(r.pin.valor) && em.estadoBloqueo().bloqueado === false && em.pinVigente() === r.pin, '«Otro PIN» tras los 10 min: PIN nuevo y desbloqueado', r);
  // Tope global por minuto: no anula, frena.
  let tope = null;
  for (let i = 0; i < 31; i++) tope = em.intentar('12345x', 'x', '10.9.' + i + '.1');
  ok(tope.error === 'ESPERA' && em.pinVigente() !== null, 'tope global de 30 fallos/min: frena sin anular el PIN', tope);

  // [QA MEDIO-1] Goteo: pocos intentos por PIN, muchos PIN, durante 7 días.
  const goteo = (cadaMin, porPin, etiqueta) => {
    const arch = path.join(tmp('goteo-' + etiqueta), 'eq.json');
    let rel = Date.parse('2026-11-20T12:00:00Z');
    const reloj7 = () => rel;
    let g = new Emparejador(arch, { ahora: reloj7 });
    const fin = rel + 7 * 86400000;
    let intentos = 0, pines = 0, bloqueadoEn = null, ultimo = null, reinicios = 0;
    let n = 0;
    while (rel < fin) {
      // La persona de la PC toca «Emparejar equipo» (si ve el aviso rojo, no: se entera del ataque).
      if (!g.estadoBloqueo().bloqueado) {
        const pp = g.pedirPin();
        if (pp.ok) pines++;
        const bueno = pp.ok ? pp.pin.valor : '000000';
        for (let k = 0; k < porPin; k++) {
          rel += 20000;                                         // dentro de los 3 min del PIN
          const malo = String((Number(bueno) + 1 + k) % 1000000).padStart(6, '0');
          ultimo = g.intentar(malo, 'x', '192.168.50.' + ((n++ % 200) + 1));
          intentos++;
          if (ultimo.error === 'PIN_BLOQUEADO' && bloqueadoEn === null) bloqueadoEn = { intentos, pines, horas: Math.round((rel - Date.parse('2026-11-20T12:00:00Z')) / 3600000) };
        }
      } else {
        ultimo = g.intentar('123456', 'x', '192.168.51.' + ((n++ % 200) + 1));   // el atacante sigue probando
      }
      rel += cadaMin * 60000;
      // Reinicio diario de LevoPrint (corte de luz): el contador y el bloqueo siguen.
      if (Math.floor((rel - 1) / 86400000) !== Math.floor((rel - cadaMin * 60000 - 1) / 86400000)) { g = new Emparejador(arch, { ahora: reloj7 }); reinicios++; }
    }
    return { g, arch, reloj7, intentos, pines, bloqueadoEn, ultimo, reinicios };
  };
  // 4 intentos por PIN, un PIN cada 10 min (24 fallos/h): nunca toca los topes por PIN ni por hora.
  const g1 = goteo(10, 4, 'rapido');
  ok(!!g1.bloqueadoEn && g1.bloqueadoEn.intentos <= 200 && g1.g.estadoBloqueo().bloqueado === true && g1.g.estadoBloqueo().acumulado === true && g1.ultimo.error === 'PIN_BLOQUEADO',
    'goteo 7 días (4 por PIN, PIN cada 10 min): termina BLOQUEADO por el acumulado de 24 h', { b: g1.bloqueadoEn, ult: g1.ultimo });
  // 4 intentos por PIN, un PIN cada 30 min (192 fallos/día, bajo el tope de 24 h): lo corta el de 7 días.
  const g2 = goteo(30, 4, 'lento');
  ok(!!g2.bloqueadoEn && g2.bloqueadoEn.intentos <= 500 && g2.reinicios >= 6 && g2.g.estadoBloqueo().acumulado === true,
    'goteo lento 7 días (192/día) con reinicio diario: lo corta el tope de 7 días', { b: g2.bloqueadoEn, reinicios: g2.reinicios });
  const g3 = new Emparejador(g1.arch, { ahora: g1.reloj7 });
  ok(g3.estadoBloqueo().bloqueado === true && g3.estadoBloqueo().acumulado === true && g3.pinVigente() === null && g3.intentar('123456', 'x', '192.168.60.1').error === 'PIN_BLOQUEADO',
    'el bloqueo por acumulado sobrevive a reiniciar LevoPrint', g3.estadoBloqueo());
  r = g3.pedirPin();
  ok(r.ok === false && r.error === 'PIN_BLOQUEADO' && r.acumulado === true && /Alguien intentó muchos PIN/.test(r.mensaje), '«Emparejar equipo» no lo levanta; aviso «Alguien intentó muchos PIN»', r);
  r = g3.pedirOtroPin();
  ok(r.ok === true && g3.estadoBloqueo().bloqueado === false && g3.fallosAcumulados().semana === 0 && /^\d{6}$/.test(r.pin.valor), '«Otro PIN» levanta el bloqueo y limpia el contador', g3.fallosAcumulados());
  const g4 = new Emparejador(g1.arch, { ahora: g1.reloj7 });
  ok(g4.estadoBloqueo().bloqueado === false && g4.fallosAcumulados().semana === 0, 'el desbloqueo también queda en disco');
  // Ráfaga: 100 fallos en 1 h (rotando IPs y PIN, respetando 30/min y 50 por PIN) → bloqueado.
  const archH = path.join(tmp('goteo-hora'), 'eq.json');
  let relH = Date.parse('2026-11-21T08:00:00Z');
  const gh = new Emparejador(archH, { ahora: () => relH });
  let rh = null;
  for (let i = 0; i < 100 && !(rh && rh.error === 'PIN_BLOQUEADO'); i++) {
    if (i % 20 === 0) { relH += 61000; gh.pedirPin(); }
    rh = gh.intentar('000000', 'x', '172.16.' + i + '.1');
    if (rh.ok) rh = gh.intentar('000001', 'x', '172.16.' + i + '.2');
  }
  ok(rh && rh.error === 'PIN_BLOQUEADO' && rh.acumulado === true && gh.fallosAcumulados().hora >= 100, '100 fallos en 1 h entre varios PIN: BLOQUEADO acumulado', { rh, f: gh.fallosAcumulados() });
  // Archivo de equipos viejo (sin fallos ni bloqueo) o con basura: arranca sin bloqueo.
  const archV = path.join(tmp('emparejar-viejo'), 'eq.json');
  fs.writeFileSync(archV, JSON.stringify({ equipos: [], fallos: ['x', null, 1e99], bloqueo: { hasta: 'mañana' } }));
  const gv = new Emparejador(archV, { ahora: () => relH });
  ok(gv.estadoBloqueo().bloqueado === false && gv.fallosAcumulados().semana === 0, 'archivo con fallos/bloqueo basura: se ignoran', gv.fallos);

  // Vencido: 90 días sin uso.
  reloj += VIDA_TOKEN_MS + 3600000;
  const em3 = new Emparejador(archivo, { ahora: () => reloj });
  ok(em3.validar(token) === null && em3.lista().length === 0, 'token sin uso por 90 días: vencido y purgado');

  // Quitar desde la ventana.
  const em4 = new Emparejador(path.join(tmp('emparejar2'), 'eq.json'));
  const t4 = em4.intentar(em4.pedirPin().pin.valor, 'Mozo 1', '192.168.0.9');
  ok(t4.ok && em4.quitar(t4.equipo.id) && em4.validar(t4.token) === null, 'quitar el equipo lo deja fuera al toque');

  // Archivo dañado.
  const arch5 = path.join(tmp('emparejar3'), 'eq.json');
  fs.writeFileSync(arch5, '{"equipos":[{"id":"x","hash":"no-es-sha","vence":9e15}, 5, null]');
  let em5 = null; try { em5 = new Emparejador(arch5); } catch { em5 = null; }
  ok(!!em5 && em5.lista().length === 0, 'archivo de equipos dañado: arranca sin equipos');
}

// ---------------------------------------------------------------- C) servidorLan
async function pruebaServidor() {
  console.log('\n-- C) servidorLan --');
  ok(lanRed.origenIpPermitido('192.168.1.5') && lanRed.origenIpPermitido('10.1.2.3') && lanRed.origenIpPermitido('172.20.0.1') && lanRed.origenIpPermitido('::ffff:192.168.0.2') && lanRed.origenIpPermitido('127.0.0.1'),
    'IP privadas y la misma PC: permitidas');
  ok(!lanRed.origenIpPermitido('8.8.8.8') && !lanRed.origenIpPermitido('100.64.1.1') && !lanRed.origenIpPermitido('172.32.0.1') && !lanRed.origenIpPermitido('169.254.1.1') && !lanRed.origenIpPermitido('fe80::1'),
    'IP pública, CGNAT 100.64/10, 172.32, 169.254 e IPv6 link-local: rechazadas');
  ok(JSON.stringify(lanRed.ipsLan({ a: [{ family: 'IPv4', address: '192.168.1.9', internal: false }, { family: 'IPv4', address: '127.0.0.1', internal: true }],
    b: [{ family: 'IPv4', address: '100.70.1.1', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '10.0.0.2', internal: false }],
    c: [1, 2, 3, 4].map((i) => ({ family: 'IPv4', address: '172.16.0.' + i, internal: false })) })) === JSON.stringify(['192.168.1.9', '10.0.0.2', '172.16.0.1', '172.16.0.2']),
  'ipsLan: solo IPv4 privadas, máximo 4');

  const em = new Emparejador(path.join(tmp('srv'), 'eq.json'));
  const token = em.intentar(em.pedirPin().pin.valor, 'Caja', '192.168.1.2').token;
  let ipFalsa = '192.168.1.50', bloqueado = false;
  const servidor = lanRed.crearServidorLan({
    emparejador: em, version: '9.9.9', origenesExtra: ['http://localhost:5173'],
    ipDe: () => ipFalsa, bloqueado: () => bloqueado,
    hola: () => ({ equipo: 'PC-CAJA-DEL-SEGUNDO-PISO', nombre: 'Cevichería Secreta', emparejable: true }),
    manejadores: {
      estado: async () => ({ ok: true, version: '9.9.9', nube: false, estaciones: [] }),
      diario: async () => ({ ok: true, recientes: [] }),
      prueba: async () => ({ ok: true }),
      imprimir: async (b) => ({ ok: true, via: 'LAN', estado: 'IMPRESO', eco: b.jobId }),
    },
  });
  const base0 = await bloqueLibre();
  // Ocupado el primero: debe abrir en el siguiente.
  const ocupa = net.createServer(); await new Promise((r) => ocupa.listen(base0, '127.0.0.1', r));
  const puerto = await lanRed.escuchar(servidor, base0, '127.0.0.1');
  ok(puerto === base0 + 1, 'puerto base ocupado: escucha en el siguiente (9121…)', { base0, puerto });
  const B = 'http://127.0.0.1:' + puerto, H = { Host: '192.168.1.10:' + puerto };

  let r = await pedir(B, '/v1/hola', { headers: H });
  ok(r.status === 200 && r.json.app === 'levoprint' && r.json.version === '9.9.9' && r.json.equipo === 'PC-CAJA-DEL-SEG' && r.json.emparejable === true && r.headers.connection === 'close', 'hola sin token: app, version, equipo corto (15), emparejable; Connection: close', r.json);
  ok(JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(['app', 'emparejable', 'equipo', 'ok', 'version']) && !JSON.stringify(r.json).includes('Secreta'), '[QA BAJO-2] hola sin token no revela el nombre del local', r.json);
  ipFalsa = '8.8.8.8';
  r = await pedir(B, '/v1/hola', { headers: H });
  ok(r.status === 403 && !r.json, 'IP pública → 403 sin cuerpo', r.status);
  ipFalsa = '100.64.3.4';
  ok((await pedir(B, '/v1/hola', { headers: H })).status === 403, 'IP CGNAT (100.64/10) → 403');
  ipFalsa = '192.168.1.50';
  ok((await pedir(B, '/v1/hola', { headers: { Host: 'evil.example.com:' + puerto } })).status === 421, 'Host de un dominio (DNS rebinding) → 421');
  ok((await pedir(B, '/v1/hola', { headers: { Host: 'caja-pc.local:' + puerto } })).status === 200, 'Host *.local permitido');
  r = await pedir(B, '/v1/hola', { headers: Object.assign({ Origin: 'https://evil.com' }, H) });
  ok(r.status === 403 && !r.headers['access-control-allow-origin'], 'Origin ajeno → 403 sin CORS', r.status);
  ok((await pedir(B, '/v1/hola', { headers: Object.assign({ Origin: 'http://komo.levodev.app' }, H) })).status === 403, 'Origin http:// (sin TLS) → 403');
  ok((await pedir(B, '/v1/hola', { headers: Object.assign({ Origin: 'https://levodev.app.evil.com' }, H) })).status === 403, 'Origin levodev.app.evil.com → 403');
  r = await pedir(B, '/v1/hola', { headers: Object.assign({ Origin: 'https://komo.levodev.app' }, H) });
  ok(r.status === 200 && r.headers['access-control-allow-origin'] === 'https://komo.levodev.app' && r.headers.vary === 'Origin', 'Origin *.levodev.app → CORS con ese origen exacto (nunca *)', r.headers);
  r = await pedir(B, '/v1/hola', { headers: Object.assign({ Origin: 'http://localhost:5173' }, H) });
  ok(r.status === 200 && r.headers['access-control-allow-origin'] === 'http://localhost:5173', 'LEVO_ORIGENES (desarrollo) también entra');
  r = await pedir(B, '/v1/imprimir', { method: 'OPTIONS', headers: Object.assign({ Origin: 'https://kipu.levodev.app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' }, H) });
  ok(r.status === 204 && r.headers['access-control-allow-private-network'] === 'true' && /Authorization/.test(r.headers['access-control-allow-headers'] || '') && r.headers['access-control-allow-origin'] === 'https://kipu.levodev.app', 'preflight PNA: 204 + Access-Control-Allow-Private-Network: true', r.headers);
  r = await pedir(B, '/v1/imprimir', { method: 'OPTIONS', headers: Object.assign({ Origin: 'https://evil.com', 'Access-Control-Request-Private-Network': 'true' }, H) });
  ok(r.status === 403 && !r.headers['access-control-allow-private-network'], 'preflight de un origen ajeno: 403 sin PNA');

  ok((await pedir(B, '/v1/estado', { headers: H })).status === 401, '/v1/estado sin token → 401');
  ok((await pedir(B, '/v1/estado', { headers: H, token: 'x'.repeat(43) })).status === 401, '/v1/estado con token inventado → 401');
  r = await pedir(B, '/v1/estado', { headers: H, token });
  ok(r.status === 200 && r.json.ok === true, '/v1/estado con token → 200');
  r = await pedir(B, '/v1/imprimir', { headers: Object.assign({ 'Content-Type': 'text/plain' }, H), token, body: '{"jobId":"x"}' });
  ok(r.status === 415, 'POST sin application/json → 415', r.status);
  r = await pedir(B, '/v1/imprimir', { headers: H, token, body: JSON.stringify({ jobId: 'job-12345678', relleno: 'x'.repeat(70 * 1024) }) });
  ok(r.status === 413 && r.json && r.json.error === 'MUY_GRANDE', 'cuerpo de más de 64 KB → 413', r.status);
  r = await pedir(B, '/v1/imprimir', { headers: H, token, body: '{roto' });
  ok(r.status === 400 && r.json.error === 'JSON_INVALIDO', 'JSON roto → 400 JSON_INVALIDO');
  r = await pedir(B, '/v1/imprimir', { headers: H, token, body: { jobId: 'job-12345678' } });
  ok(r.status === 200 && r.json.eco === 'job-12345678', 'imprimir con token llega al manejador');
  r = await pedir(B, '/v1/emparejar', { headers: H, body: { pin: '12', nombre: 'x' } });
  ok(r.status === 401 && (r.json.error === 'SIN_PIN' || r.json.error === 'PIN_INVALIDO'), 'emparejar con PIN errado → 401', r.json);
  const pv = em.pedirPin().pin; pv.expira = Date.now() - 1;
  r = await pedir(B, '/v1/emparejar', { headers: H, body: { pin: pv.valor, nombre: 'x' } });
  ok(r.status === 401 && r.json.error === 'PIN_VENCIDO', '[QA MEDIO-1] PIN vencido → 401 PIN_VENCIDO', r.json);
  em.bloqueo = { hasta: Date.now() + BLOQUEO_PIN_MS };
  r = await pedir(B, '/v1/emparejar', { headers: H, body: { pin: '123456', nombre: 'x' } });
  ok(r.status === 423 && r.json.error === 'PIN_BLOQUEADO' && r.json.esperaS > 0, 'emparejar con el PIN bloqueado → 423 PIN_BLOQUEADO', r.json);
  em.bloqueo = null;
  bloqueado = true;
  ok((await pedir(B, '/v1/estado', { headers: H, token })).status === 423 && (await pedir(B, '/v1/hola', { headers: H })).status === 200, 'agente desactivado en la consola: 423 (menos /v1/hola)');
  ok((await pedir(B, '/no-existe', { headers: H })).status === 423, 'desactivado: tampoco rutas sueltas');
  bloqueado = false;
  ok((await pedir(B, '/no-existe', { headers: H, token })).status === 404, 'ruta desconocida → 404');
  servidor.close(); servidor.closeAllConnections(); ocupa.close();
}

// ---------------------------------------------------------------- D) agente completo
function arrancarAgente(dir, env, archivo) {
  if (!archivo) {
    fs.copyFileSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'));
    fs.cpSync(path.join(__dirname, 'lib'), path.join(dir, 'lib'), { recursive: true });
  }
  const hijo = spawn(process.execPath, [path.join(dir, archivo || 'index.js')], { cwd: dir, env: Object.assign({}, process.env, env), windowsHide: true });
  const log = [];
  hijo.stdout.on('data', (d) => log.push(String(d)));
  hijo.stderr.on('data', (d) => log.push(String(d)));
  return { hijo, log, cerrar: () => new Promise((r) => { if (hijo.exitCode !== null) return r(); hijo.once('exit', () => r()); hijo.kill(); }) };
}
const DEV_KOMO = '11111111-1111-4111-8111-111111111111';
const DEV_KIPU = '22222222-2222-4222-8222-222222222222';
const DEV_OTRO = '44444444-4444-4444-8444-444444444444';

async function pruebaAgente() {
  console.log('\n-- D) agente completo --');
  const P = await puertoLibre();
  const imp = await impresora('127.0.0.1', P);
  const cerrado = await puertoLibre(); // nadie escucha: impresora apagada
  const mock = await crearMock({
    apps: {
      komo: {
        devices: [DEV_KOMO],
        estaciones: [{ id: 'e1', nombre: 'Cocina' }, { id: 'e2', nombre: 'Caja' }, { id: 'e3', nombre: 'Barra' }],
        destinos: {
          e1: { transporte: 'red', ip: '127.0.0.1', puerto: P },
          e2: { transporte: 'red', ip: '127.0.0.1', puerto: cerrado },
          e3: { transporte: 'usb', usbId: 'POS-58 de la barra', equipo: DEV_OTRO },
        },
      },
      kipu: { sinLan: true, devices: [DEV_KIPU], estaciones: [{ id: 'k1', nombre: 'Caja' }] },
    },
  });
  const dir = tmp('agente');
  const datos = path.join(dir, 'datos');
  const gui = await bloqueLibre(), lanBase = await bloqueLibre();
  const comunes = {
    LEVO_ANON: 'anon-de-prueba', LEVO_SINVENTANA: '1', LEVO_VINCULOS: 'komo:' + DEV_KOMO + ',kipu:' + DEV_KIPU,
    LEVO_PUERTO_GUI: String(gui), LEVO_PUERTO_LAN: String(lanBase), LEVO_HOST_LAN: '127.0.0.1', LEVO_DATOS_DIR: datos,
    LEVO_LOCK_DIR: path.join(dir, 'lock'), APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'local'),
    LEVO_PRUEBA_CONFIG_MS: '1500', LEVO_BUSCAR_SUBRED: '127.0.0', LEVO_BUSCAR_PUERTO: String(cerrado),
    LEVO_PRUEBA_PS: path.join(__dirname, 'doble_powershell.cjs'), LP_DOBLE_SALIDA: path.join(dir, 'usb.jsonl'),
  };
  delete process.env.LEVO_LAN; // el interruptor lo decide levoprint.txt (el entorno manda sobre el .txt)
  const W = 'http://127.0.0.1:' + gui, HW = { Host: '127.0.0.1:' + gui };
  let A = arrancarAgente(dir, Object.assign({}, comunes, { LEVO_URL: mock.url }));
  try {
    const e0 = await hasta(async () => { const e = (await pedir(W, '/estado', { headers: HW })).json; return e && e.lan && e.vinculos && e.vinculos[0].estaciones.length === 3 ? e : null; }, 15000);
    ok(!!e0 && e0.version === VERSION && e0.lan.activo === false && e0.lan.escuchando === false && e0.lan.pin === null, 'la ventana muestra «Imprimir sin internet» APAGADO por defecto y sin PIN', e0 && e0.lan);
    ok((await pedir('http://127.0.0.1:' + lanBase, '/v1/hola', { headers: { Host: '127.0.0.1' } })).status === 0, 'apagado: el puerto LAN no escucha');
    const lan0 = await hasta(() => mock.estado.komo.lan[0], 8000);
    ok(!!lan0 && Array.isArray(lan0.lan.ips) && lan0.lan.ips.length === 0 && lan0.lan.puerto === null, 'arranque con el interruptor apagado: un latido lan:{ips:[],puerto:null} (limpia una IP vieja en la nube)', lan0);
    await espera(2500);
    ok(mock.estado.komo.lan.length === 1, 'apagado y ya informado: no repite el latido', mock.estado.komo.lan.length);
    ok((await pedir(W, '/lan', { headers: Object.assign({ Origin: 'https://evil.com' }, HW), body: { activo: true } })).status === 403, 'una página ajena no puede encender el interruptor (403)');
    let r = await pedir(W, '/lan', { headers: HW, body: { activo: true } });
    ok(r.status === 200 && r.json.ok === true && r.json.lan.escuchando === true && r.json.lan.pin === null && r.json.persistido === true, '[QA MEDIO-1] interruptor encendido: escucha y SIN PIN (hasta «Emparejar equipo»)', r.json);
    ok(/^LEVO_LAN=1\r?$/m.test(fs.readFileSync(path.join(dir, 'levoprint.txt'), 'utf8')), 'el interruptor queda guardado en levoprint.txt (LEVO_LAN=1)');
    const L = 'http://127.0.0.1:' + r.json.lan.puerto, HL = { Host: '127.0.0.1:' + r.json.lan.puerto, Origin: 'https://komo.levodev.app' };
    r = await pedir(L, '/v1/hola', { headers: HL });
    ok(r.status === 200 && r.json.emparejable === false, '[QA MEDIO-1] sin pulsar «Emparejar equipo»: /v1/hola emparejable:false', r.json);
    r = await pedir(L, '/v1/emparejar', { headers: HL, body: { pin: '123456', nombre: 'Tablet mozo' } });
    ok(r.status === 401 && r.json.error === 'SIN_PIN', '[QA MEDIO-1] sin pulsar «Emparejar equipo»: SIN_PIN', r.json);
    ok((await pedir(W, '/lan/pin', { headers: Object.assign({ Origin: 'https://evil.com' }, HW), body: {} })).status === 403, 'una página ajena no puede pedir PIN (403)');
    r = await pedir(W, '/lan/pin', { headers: HW, body: {} });
    ok(r.status === 200 && r.json.ok === true && /^\d{6}$/.test(r.json.lan.pin || '') && r.json.lan.pinVenceS > 170 && r.json.lan.pinVenceS <= 180, '«Emparejar equipo» en la ventana: PIN de 6 dígitos por 3 min', r.json);
    const pin = r.json.lan.pin;

    r = await pedir(L, '/v1/hola', { headers: HL });
    ok(r.status === 200 && r.json.app === 'levoprint' && r.json.version === VERSION && r.json.emparejable === true && typeof r.json.equipo === 'string' && r.json.equipo.length <= 15 && !('nombre' in r.json), 'GET /v1/hola (sin nombre del local)', r.json);
    r = await pedir(L, '/v1/emparejar', { headers: HL, body: { pin: pin === '000000' ? '111111' : '000000', nombre: 'Tablet mozo' } });
    ok(r.status === 401 && r.json.error === 'PIN_INVALIDO', 'PIN errado → 401 PIN_INVALIDO', r.json);
    r = await pedir(L, '/v1/emparejar', { headers: HL, body: { pin, nombre: 'Tablet mozo' } });
    ok(r.status === 200 && r.json.ok && typeof r.json.token === 'string' && r.json.vence, 'PIN bueno → token y vence', r.json);
    const token = r.json.token;
    const e1 = (await pedir(W, '/estado', { headers: HW })).json;
    ok(e1.lan.pin === null && e1.lan.equipos.length === 1 && e1.lan.equipos[0].nombre === 'Tablet mozo', '[QA MEDIO-1] tras emparejar: sin PIN (no se crea otro solo) y el equipo en la lista', e1.lan);
    ok((await pedir(L, '/v1/hola', { headers: HL })).json.emparejable === false, 'tras emparejar: emparejable:false');

    r = await pedir(L, '/v1/estado', { headers: HL, token });
    const ests = (r.json && r.json.estaciones) || [];
    const est = (id) => ests.find((x) => x.id === id) || {};
    ok(r.status === 200 && r.json.version === VERSION && r.json.nube === true && est('e1').listo === true && est('e1').transporte === 'red' && est('e3').listo === false && est('e3').transporte === 'usb' && est('k1').app === 'kipu',
      'GET /v1/estado: version, nube, estaciones con transporte y listo', r.json);

    const J1 = 'ck-1111:e1';
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: J1, estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '9', mozo: 'Ana', hora: '13:00', items: [{ cantidad: 2, nombre: 'Ceviche' }] } } });
    ok(r.status === 200 && r.json.ok === true && r.json.via === 'LAN' && r.json.estado === 'IMPRESO', 'POST /v1/imprimir → IMPRESO por la LAN', r.json);
    ok(!!(await hasta(() => imp.recibido.some((t) => t.includes('MESA 9') && t.includes('Ceviche')), 4000)), 'la impresora falsa recibió la comanda');
    const nImp = imp.recibido.length;
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: J1, estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '9', items: [] } } });
    ok(r.status === 200 && r.json.estado === 'YA_IMPRESO' && imp.recibido.length === nImp, 'mismo jobId otra vez → YA_IMPRESO sin papel', r.json);
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-2222:e3', estacion: 'e3', tipo: 'COMANDA', payload: {} } });
    ok(r.status === 409 && r.json.ok === false && r.json.error === 'OTRO_EQUIPO', 'estación USB de otro equipo → OTRO_EQUIPO', r.json);
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-3333:e2', estacion: 'e2', tipo: 'TICKET', payload: { items: [] } } });
    ok(r.status === 502 && r.json.error === 'IMPRESORA_NO_RESPONDE' && !/ECONN|127\.0\.0\.1/.test(JSON.stringify(r.json)), 'impresora apagada → IMPRESORA_NO_RESPONDE sin detalle crudo de red', r.json);
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-4444:zz', estacion: 'zz', tipo: 'COMANDA', payload: {} } });
    ok(r.status === 404 && r.json.error === 'ESTACION_DESCONOCIDA', 'estación desconocida → 404');
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-5555:e1', estacion: 'e1', tipo: 'RAW', payload: {} } });
    ok(r.status === 400 && r.json.error === 'TIPO_INVALIDO', 'tipo desconocido → 400 (no imprime JSON crudo)');
    const nDinero = imp.recibido.length;
    for (const tipo of ['CPE', 'CIERRE', 'TURNO', 'CARTA_QR']) {
      r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-din-' + tipo + ':e1', estacion: 'e1', tipo, payload: { total: 1 } } });
      ok(r.status === 400 && r.json.error === 'TIPO_INVALIDO', '[QA MEDIO-2] ' + tipo + ' por la LAN → 400 TIPO_INVALIDO', r.json);
    }
    ok(imp.recibido.length === nDinero, 'ningún papel de dinero salió por la LAN');
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-prec-1:e1', estacion: 'e1', tipo: 'PRECUENTA', payload: { mesa: '21', items: [{ cantidad: 1, nombre: 'Causa', precio: 12 }], total: 12 } } });
    ok(r.status === 200 && r.json.estado === 'IMPRESO', 'PRECUENTA por la LAN → IMPRESO', r.json);
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-prueba-1:e1', estacion: 'e1', tipo: 'PRUEBA', payload: {} } });
    ok(r.status === 200 && r.json.estado === 'IMPRESO', 'PRUEBA por /v1/imprimir → IMPRESO', r.json);
    r = await pedir(L, '/v1/prueba', { headers: HL, token, body: { estacion: 'e1' } });
    ok(r.status === 200 && r.json.ok && (await hasta(() => imp.recibido.some((t) => t.includes('PRUEBA LEVOPRINT OK')), 3000)), 'POST /v1/prueba saca el papel de prueba');
    r = await pedir(L, '/v1/diario', { headers: HL, token });
    ok(r.status === 200 && r.json.recientes.some((x) => x.jobId === J1 && x.estado === 'IMPRESO' && x.origen === 'LAN') && r.json.recientes.some((x) => x.jobId === 'ck-3333:e2' && x.estado === 'FALLO'), 'GET /v1/diario', r.json);

    // Vuelve internet: la nube entrega el MISMO papel (payload.jobId) → se marca hecho sin imprimir.
    const nAntes = imp.recibido.length;
    mock.estado.komo.jobs.push(
      { id: 101, estacion: 'e1', tipo: 'COMANDA', payload: { jobId: J1, mesa: '9', items: [{ cantidad: 2, nombre: 'Ceviche' }] } },
      { id: 102, estacion: 'e1', tipo: 'COMANDA', payload: { jobId: 'ck-9999:e1', mesa: '10', items: [{ cantidad: 1, nombre: 'Chicha' }] } },
    );
    const marc = await hasta(() => { const m = mock.estado.komo.marcados; return m.some((x) => x.id === 101) && m.some((x) => x.id === 102) ? m : null; }, 10000);
    const m101 = (marc || []).find((x) => x.id === 101) || {}, m102 = (marc || []).find((x) => x.id === 102) || {};
    await espera(300);
    ok(m101.ok === true && !imp.recibido.slice(nAntes).some((t) => t.includes('MESA 9')), 'nube con un jobId ya impreso por la LAN → print_marcar ok SIN imprimir', m101);
    ok(m102.ok === true && imp.recibido.slice(nAntes).some((t) => t.includes('MESA 10')), 'un jobId nuevo de la nube sí se imprime', m102);
    // Un trabajo de la nube sin jobId que se reentrega (print_marcar perdido) tampoco se repite.
    const nAntes2 = imp.recibido.length;
    mock.estado.komo.jobs.push({ id: 103, estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '11', items: [] } });
    await hasta(() => mock.estado.komo.marcados.some((x) => x.id === 103), 8000);
    mock.estado.komo.jobs.push({ id: 103, estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '11', items: [] } });
    await hasta(() => mock.estado.komo.marcados.filter((x) => x.id === 103).length >= 2, 8000);
    await espera(300);
    ok(imp.recibido.slice(nAntes2).filter((t) => t.includes('MESA 11')).length === 1, 'trabajo de la nube reentregado (marcar perdido) → un solo papel');
    // [QA MEDIO-2] Un TICKET de la nube con un jobId que ya salió por la LAN SÍ se imprime.
    const nAntesT = imp.recibido.length;
    mock.estado.komo.jobs.push({ id: 104, estacion: 'e1', tipo: 'TICKET', payload: { jobId: J1, mesa: '77', items: [{ cantidad: 1, nombre: 'Lomo', precio: 30 }], total: 30 } });
    const m104 = await hasta(() => mock.estado.komo.marcados.find((x) => x.id === 104), 8000);
    ok(!!m104 && m104.ok === true && !!(await hasta(() => imp.recibido.slice(nAntesT).some((t) => t.includes('MESA 77') && t.includes('Lomo')), 3000)), 'TICKET de la nube con un jobId ya impreso por la LAN → se imprime igual', m104);

    // [QA MEDIO-1] Lo que la nube rechaza no se reenvía.
    mock.estado.komo.lanRechazar.add('ck-rech-1:e1|e1');
    r = await pedir(L, '/v1/imprimir', { headers: HL, token, body: { jobId: 'ck-rech-1:e1', estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '31', items: [] } } });
    ok(r.json && r.json.estado === 'IMPRESO', 'comanda por la LAN que la nube va a rechazar', r.json);
    const conRech = () => mock.estado.komo.lan.filter((p) => (p.impresos || []).some((x) => x.clave === 'ck-rech-1:e1'));
    ok(!!(await hasta(() => conRech().length >= 1, 10000)), 'el rechazado llega una vez a agente_lan');
    await espera(4000);
    ok(conRech().length === 1, 'lo rechazado por la nube (rechazados_det por estación) no se vuelve a mandar', conRech().length);

    // agente_lan: IPs + puerto + impresos por la LAN; la nube los registra.
    const lanCall = await hasta(() => mock.estado.komo.lan.find((p) => (p.impresos || []).some((x) => x.clave === J1)), 10000);
    ok(!!lanCall && lanCall.device === DEV_KOMO && lanCall.version === 'exe/' + VERSION && lanCall.lan && Array.isArray(lanCall.lan.ips) && lanCall.lan.puerto === Number(L.split(':').pop())
      && lanCall.impresos.every((x) => x.estacion && x.ts && !String(x.clave).startsWith('nube:')), 'komo_agente_lan recibe device, version, lan{ips,puerto} e impresos', lanCall);
    ok(!(lanCall.impresos || []).some((x) => x.clave === 'ck-9999:e1'), 'lo impreso por la nube no se reporta como LAN');
    await espera(4000);
    const repetidos = mock.estado.komo.lan.filter((p) => (p.impresos || []).some((x) => x.clave === J1)).length;
    ok(repetidos === 1, 'lo ya registrado no se vuelve a mandar', repetidos);
    const kipuLan = mock.llamadas.filter((l) => l.prefijo === 'kipu' && l.fn === 'agente_lan').length;
    ok(kipuLan === 1, 'KIPU sin el módulo (404): una llamada y pausa de 10 min', kipuLan);
    ok(fs.existsSync(path.join(datos, 'levoprint-estaciones.json')) && !fs.readFileSync(path.join(datos, 'levoprint-estaciones.json'), 'utf8').includes(DEV_KOMO), 'las rutas quedan en disco (sin el token del equipo)');

    // Apagar con red: el latido avisa lan:{ips:[],puerto:null} para que la nube borre la IP.
    const nLan = mock.estado.komo.lan.length;
    r = await pedir(W, '/lan', { headers: HW, body: { activo: false } });
    const apag = await hasta(() => mock.estado.komo.lan.slice(nLan).find((p) => p.lan && p.lan.puerto === null), 8000);
    ok(r.json && r.json.lan.escuchando === false && !!apag && Array.isArray(apag.lan.ips) && apag.lan.ips.length === 0, 'apagar el interruptor: agente_lan con lan:{ips:[],puerto:null}', apag);
    const nLan2 = mock.estado.komo.lan.length;
    r = await pedir(W, '/lan', { headers: HW, body: { activo: true } });
    const encendido = await hasta(() => mock.estado.komo.lan.slice(nLan2).find((p) => p.lan && typeof p.lan.puerto === 'number'), 8000);
    ok(r.json && r.json.lan.escuchando === true && !!encendido, 'volver a encender: agente_lan con el puerto otra vez', encendido);

    // Reinicio SIN red: el servidor (mock) no existe; el agente imprime con las rutas del disco.
    await A.cerrar();
    A = arrancarAgente(dir, Object.assign({}, comunes, { LEVO_URL: 'http://127.0.0.1:' + cerrado }), 'index.js');
    const e2 = await hasta(async () => { const e = (await pedir(W, '/estado', { headers: HW })).json; return e && e.lan && e.lan.escuchando ? e : null; }, 15000);
    ok(!!e2 && e2.lan.activo === true && e2.lan.equipos.length === 1, 'reinicio sin red: el interruptor sigue encendido y el equipo emparejado', e2 && e2.lan);
    const L2 = 'http://127.0.0.1:' + e2.lan.puerto, HL2 = { Host: '127.0.0.1:' + e2.lan.puerto, Origin: 'https://komo.levodev.app' };
    r = await pedir(L2, '/v1/estado', { headers: HL2, token });
    ok(r.status === 200 && r.json.nube === false && (r.json.estaciones || []).some((x) => x.id === 'e1' && x.listo), 'sin red: /v1/estado con nube:false y las estaciones del disco', r.json);
    const nAntes3 = imp.recibido.length;
    r = await pedir(L2, '/v1/imprimir', { headers: HL2, token, body: { jobId: 'ck-7777:e1', estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '12', items: [{ cantidad: 1, nombre: 'Arroz' }] } } });
    ok(r.status === 200 && r.json.estado === 'IMPRESO' && (await hasta(() => imp.recibido.slice(nAntes3).some((t) => t.includes('MESA 12')), 4000)), 'sin red y tras reiniciar: imprime con las rutas guardadas', r.json);
    r = await pedir(L2, '/v1/imprimir', { headers: HL2, token, body: { jobId: J1, estacion: 'e1', tipo: 'COMANDA', payload: {} } });
    ok(r.json && r.json.estado === 'YA_IMPRESO', 'el diario sobrevive al reinicio (YA_IMPRESO)', r.json);

    // Quitar el equipo desde la ventana → su token deja de servir.
    r = await pedir(W, '/lan/quitar', { headers: HW, body: { id: e2.lan.equipos[0].id } });
    ok(r.status === 200 && (await pedir(L2, '/v1/estado', { headers: HL2, token })).status === 401, 'quitar el equipo en la ventana: su token → 401');
    // Apagar el interruptor: el puerto se cierra.
    r = await pedir(W, '/lan', { headers: HW, body: { activo: false } });
    ok(r.status === 200 && r.json.lan.escuchando === false && (await pedir(L2, '/v1/hola', { headers: HL2 })).status === 0, 'apagar el interruptor cierra el puerto LAN');
    ok(/^LEVO_LAN=0\r?$/m.test(fs.readFileSync(path.join(dir, 'levoprint.txt'), 'utf8')), 'apagado guardado en levoprint.txt');
  } catch (e) {
    ok(false, 'excepción en la prueba del agente', e && e.stack);
  } finally {
    if (fallas) console.log('\n--- log del agente ---\n' + A.log.join('').slice(-5000));
    await A.cerrar();
    await mock.close();
    imp.s.close();
  }
}

// ---------------------------------------------------------------- E) paquete del .exe
async function pruebaPaquete() {
  console.log('\n-- E) paquete del .exe --');
  execFileSync(process.execPath, [path.join(__dirname, 'empaquetar.mjs')], { cwd: __dirname, stdio: 'pipe' });
  const bundle = path.join(__dirname, 'dist', 'levoprint.bundle.js');
  const sea = JSON.parse(fs.readFileSync(path.join(__dirname, 'sea-config.json'), 'utf8'));
  ok(sea.main === 'dist/levoprint.bundle.js', 'sea-config apunta al paquete');
  const dir = tmp('paquete');
  fs.copyFileSync(bundle, path.join(dir, 'levoprint.bundle.js'));
  const gui = await bloqueLibre();
  const X = arrancarAgente(dir, {
    LEVO_SINVENTANA: '1', LEVO_VINCULOS: '', LEVO_PUERTO_GUI: String(gui), LEVO_URL: 'http://127.0.0.1:1', LEVO_ANON: 'x',
    LEVO_LOCK_DIR: path.join(dir, 'lock'), LOCALAPPDATA: path.join(dir, 'local'), APPDATA: path.join(dir, 'appdata'), LEVO_DATOS_DIR: path.join(dir, 'datos'),
  }, 'levoprint.bundle.js');
  try {
    const e = await hasta(async () => (await pedir('http://127.0.0.1:' + gui, '/estado', { headers: { Host: '127.0.0.1:' + gui } })).json, 10000);
    ok(!!e && e.version === VERSION && !!e.lan, 'el paquete arranca solo (sin lib/ al lado) con la versión ' + VERSION, e ? e.version : X.log.join('').slice(-1500));
  } finally { await X.cerrar(); }
}

(async () => {
  try {
    await pruebaDiario();
    pruebaEmparejar();
    await pruebaServidor();
    await pruebaAgente();
    await pruebaPaquete();
  } catch (e) {
    ok(false, 'excepción inesperada', e && e.stack);
  }
  await espera(300);
  try { fs.rmSync(tmpRaiz, { recursive: true, force: true }); } catch { /* Windows puede tener un log abierto */ }
  console.log('\nLP-O02 · ' + oks + ' OK, ' + fallas + ' FALLA(S)');
  process.exit(fallas ? 1 : 0);
})();
