// ============================================================
// LevoPrint F2 · prueba de punta a punta con el agente REAL (node index.js,
// o el empaquetado con LP_MAIN=dist/levoprint.bundle.js), una nube falsa y
// dos impresoras TCP falsas (cocina y barra). Puertos propios al azar.
//
// Guion (lo que pidio Luis):
//   1) emparejar un equipo con PIN; seguridad (sin token, Host, Origin);
//   2) se CAE la nube -> la comanda sale por la LAN, una sola vez;
//   3) dos trabajos a la vez (cocina y barra) + uno repetido en paralelo;
//   4) VUELVE la nube con la MISMA comanda (mismo jobId) -> no se reimprime;
//      la nueva si sale; la nube recibe el reporte de impresos por la LAN;
//   5) impresora atascada: no frena a la otra;
//   6) reinicio del agente SIN internet: estaciones y diario sobreviven.
// ============================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { impresoraFalsa, nubeFalsa, puertoLibre, pedir, esperar, hasta } = require('./util/falsos');

const MAIN = path.join(__dirname, '..', process.env.LP_MAIN || 'index.js');
const ORIGEN = 'http://localhost:5173';
const uuid = () => crypto.randomUUID();

function arrancarAgente(env) {
  const hijo = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  hijo.salida = '';
  hijo.stdout.on('data', (c) => { hijo.salida += c; });
  hijo.stderr.on('data', (c) => { hijo.salida += c; });
  return hijo;
}
function parar(hijo) { return new Promise((r) => { if (hijo.exitCode !== null) return r(); hijo.once('exit', () => r()); hijo.kill(); }); }

test('F2 de punta a punta: LAN sin nube, dedupe al volver, simultaneos, atascada, reinicio', { timeout: 90000 }, async (t) => {
  const cocina = await impresoraFalsa();
  const barra = await impresoraFalsa();
  const EST_COCINA = uuid(), EST_BARRA = uuid(), EST_ATASCADA = uuid();
  const nube = await nubeFalsa({ prefijo: 'komo', estaciones: [
    { id: EST_COCINA, nombre: 'Cocina', ip: '127.0.0.1', puerto: cocina.puerto },
    { id: EST_BARRA, nombre: 'Barra', ip: '127.0.0.1', puerto: barra.puerto },
    // 10.255.255.1 no existe: la conexion se queda colgada hasta el tope de 5 s
    { id: EST_ATASCADA, nombre: 'Atascada', ip: '10.255.255.1', puerto: 9100 },
  ] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e2e-'));
  const PG = await puertoLibre(), PL = await puertoLibre();
  const env = {
    LEVO_DIR: dir, LEVO_URL: nube.url, LEVO_ANON: 'anon-falsa', LEVO_DEVICE: uuid(), LEVO_PREFIJO: 'komo',
    LEVO_SINVENTANA: '1', LEVO_PUERTO_GUI: String(PG), LEVO_PUERTO_LAN: String(PL), LEVO_ORIGENES: ORIGEN,
    LEVO_TCP_PRUEBAS: '1', LEVO_LATIDO_MS: '1000',
  };
  let agente = arrancarAgente(env);
  t.after(async () => { await parar(agente); await cocina.cerrar(); await barra.cerrar(); await nube.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); });

  // [QA MEDIO-3] Sin PIN ni equipos emparejados, el 9120 NO esta abierto.
  assert.ok(await hasta(async () => (await pedir(PG, 'GET', '/estado').catch(() => ({}))).status === 200, 15000), 'la ventana no levanto:\n' + agente.salida);
  assert.equal(await pedir(PL, 'GET', '/v1/hola').then(() => 'abierto', () => 'cerrado'), 'cerrado', 'el 9120 no se abre solo');
  const pinInicial = (await pedir(PG, 'POST', '/lan/pin', { cuerpo: {} })).json.pin;   // "Activar impresion sin internet"
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/hola').catch(() => ({}))).status === 200, 15000), 'el servidor LAN no levanto:\n' + agente.salida);
  assert.equal((await pedir(PL, 'GET', '/v1/hola')).json.prefijo, undefined, '/v1/hola no dice de que app es');
  assert.ok(await hasta(() => nube.estado.llamadas.some((u) => u.endsWith('komo_print_tomar')), 10000), 'el ciclo no hablo con la nube');

  // ---- 0) la ventana local sirve una pagina con JS valido ----
  const pagina = await new Promise((resolve, reject) => require('http').get({ host: '127.0.0.1', port: PG, path: '/' }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t));
  }).on('error', reject));
  const script = (/<script>([\s\S]*?)<\/script>/.exec(pagina) || [])[1];
  assert.ok(script && script.includes('btnBuscar'), 'la ventana trae la seccion Buscar impresoras');
  assert.doesNotThrow(() => new Function(script), 'JS de la ventana con error de sintaxis');

  // ---- 1) emparejar y seguridad ----
  const sinToken = await pedir(PL, 'GET', '/v1/estado');
  assert.equal(sinToken.status, 401);
  const hostMalo = await pedir(PL, 'GET', '/v1/hola', { cabeceras: { Host: 'evil.com' } });
  assert.equal(hostMalo.status, 421, 'DNS rebinding debe cortarse');
  const origenMalo = await pedir(PL, 'POST', '/v1/emparejar', { cuerpo: { pin: '000000' }, cabeceras: { Origin: 'https://evil.com' } });
  assert.equal(origenMalo.status, 403);
  const guiCsrf = await pedir(PG, 'POST', '/lan/pin', { cuerpo: {}, cabeceras: { Origin: 'https://evil.com' } });
  assert.equal(guiCsrf.status, 403, 'la ventana no acepta ordenes de otra pagina');
  const pre = await pedir(PL, 'OPTIONS', '/v1/imprimir', { cabeceras: { Origin: ORIGEN, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], ORIGEN);
  assert.equal(pre.headers['access-control-allow-private-network'], 'true');
  const pin = pinInicial;
  assert.match(pin, /^\d{6}$/);
  const par = await pedir(PL, 'POST', '/v1/emparejar', { cuerpo: { pin, nombre: 'Caja 1' }, cabeceras: { Origin: ORIGEN } });
  assert.equal(par.status, 200, JSON.stringify(par.json));
  const auth = { Authorization: 'Bearer ' + par.json.token, Origin: ORIGEN };
  const est = await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth });
  assert.equal(est.status, 200);
  assert.equal(est.json.estaciones.length, 3);

  // ---- 2) se cae la nube: la comanda sale por la LAN, una sola vez ----
  nube.estado.caida = true;
  const J1 = uuid();
  const comanda = { mesa: '7', mozo: 'Ana', hora: '13:05', items: [{ cantidad: 2, nombre: 'Lomo saltado' }], jobId: J1 };
  const r1 = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J1, tipo: 'COMANDA', estacion: EST_COCINA, payload: comanda }, cabeceras: auth });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.duplicado, false);
  assert.ok(await hasta(() => cocina.papeles.length === 1, 3000));
  assert.match(cocina.textos()[0], /COMANDA[\s\S]*MESA 7[\s\S]*Lomo saltado/);
  const r1b = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J1, tipo: 'COMANDA', estacion: EST_COCINA, payload: comanda }, cabeceras: auth });
  assert.equal(r1b.json.duplicado, true, 'el reintento del mismo jobId no reimprime');
  const malo = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: 'x', tipo: 'COMANDA', estacion: EST_COCINA }, cabeceras: auth });
  assert.equal(malo.status, 400);
  const otraEst = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: uuid(), tipo: 'COMANDA', estacion: uuid() }, cabeceras: auth });
  assert.equal(otraEst.status, 404);

  // ---- 3) simultaneos: cocina + barra + el mismo jobId dos veces a la vez ----
  const J2 = uuid(), J3 = uuid();
  const enParalelo = await Promise.all([
    pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J2, tipo: 'COMANDA', estacion: EST_COCINA, payload: { mesa: '8', items: [{ cantidad: 1, nombre: 'Ceviche' }], jobId: J2 } }, cabeceras: auth }),
    pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J3, tipo: 'COMANDA', estacion: EST_BARRA, payload: { mesa: '8', items: [{ cantidad: 2, nombre: 'Pisco sour' }], jobId: J3 } }, cabeceras: auth }),
    pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J3, tipo: 'COMANDA', estacion: EST_BARRA, payload: { mesa: '8', items: [{ cantidad: 2, nombre: 'Pisco sour' }], jobId: J3 } }, cabeceras: auth }),
  ]);
  assert.ok(enParalelo.every((r) => r.status === 200 && r.json.ok), JSON.stringify(enParalelo.map((r) => r.json)));
  assert.equal(enParalelo.filter((r) => r.json.duplicado).length, 1, 'de los dos J3 a la vez, uno es duplicado');
  assert.ok(await hasta(() => cocina.papeles.length === 2 && barra.papeles.length === 1, 3000));
  await esperar(300);
  assert.equal(barra.papeles.length, 1, 'J3 salio UNA vez');

  // ---- 4) vuelve la nube con la MISMA comanda J1 (la subio la bandeja del mozo) + una nueva ----
  const jRepetido = nube.encolar('COMANDA', EST_COCINA, comanda);                 // payload.jobId = J1
  const J5 = uuid();
  const jNuevo = nube.encolar('COMANDA', EST_COCINA, { mesa: '9', items: [{ cantidad: 1, nombre: 'Arroz chaufa' }], jobId: J5 });
  nube.estado.caida = false;
  assert.ok(await hasta(() => nube.estado.marcados.length >= 2, 20000), 'la nube no recibio los marcar:\n' + agente.salida.slice(-1500));
  assert.deepEqual(nube.estado.marcados.map((m) => [m.id, m.ok]).sort(), [[jRepetido.id, true], [jNuevo.id, true]].sort());
  assert.ok(await hasta(() => cocina.papeles.length === 3, 3000));
  await esperar(500);
  assert.equal(cocina.papeles.length, 3, 'J1 NO se reimprimio al volver la nube (solo salio J5)');
  assert.match(cocina.textos()[2], /Arroz chaufa/);
  assert.match(agente.salida, /\[dedupe\]/);
  // reporte de impresos por la LAN a la nube (para que no los vuelva a encolar)
  assert.ok(await hasta(() => nube.estado.latidosLan.some((l) => (l.impresos || []).length), 20000), 'falta el latido LAN con impresos');
  const reportados = new Set(nube.estado.latidosLan.flatMap((l) => (l.impresos || []).map((x) => x.clave)));
  for (const j of [J1, J2, J3]) assert.ok(reportados.has(j), 'reportado ' + j);
  const lat = nube.estado.latidosLan.filter((l) => l.lan).pop();   // antes del PIN el 9120 estaba cerrado: lan null
  assert.equal(lat.lan.puerto, PL);
  assert.equal(lat.version, '1.8.0');

  // ---- 4b) [re-QA NUEVO-1] reimpresion:true por la LAN y luego por la nube con el MISMO jobId = UN papel ----
  const JR = uuid();
  const reimp = { mesa: '7', items: [{ cantidad: 1, nombre: 'Ceviche' }], reimpresion: true, jobId: JR };
  const cocinaR = cocina.papeles.length;
  const rR = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: JR, tipo: 'COMANDA', estacion: EST_COCINA, payload: reimp }, cabeceras: auth });
  assert.equal(rR.json.ok, true);
  const marcadosAntes = nube.estado.marcados.length;
  const jR = nube.encolar('COMANDA', EST_COCINA, reimp);
  assert.ok(await hasta(() => nube.estado.marcados.some((m) => m.id === jR.id), 20000), 'la nube no recibio el marcar de la reimpresion');
  await esperar(300);
  assert.equal(cocina.papeles.length, cocinaR + 1, 'la reimpresion salio UNA vez');
  assert.ok(nube.estado.marcados.length > marcadosAntes);

  // ---- 5) impresora atascada no frena a la otra ----
  const t0 = Date.now();
  const atascada = pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: uuid(), tipo: 'COMANDA', estacion: EST_ATASCADA, payload: { mesa: '1', items: [] } }, cabeceras: auth });
  const rapida = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: uuid(), tipo: 'COMANDA', estacion: EST_COCINA, payload: { mesa: '2', items: [] } }, cabeceras: auth });
  assert.equal(rapida.json.ok, true);
  assert.ok(Date.now() - t0 < 2000, 'la cocina no espero a la atascada');
  const ra = await atascada;
  assert.equal(ra.status, 502);
  assert.equal(ra.json.ok, false);
  assert.doesNotMatch(ra.json.mensaje, /10\.255|timeout|ECONN/i, 'la app no ve el error crudo de la red');

  // ---- 5b) [QA ALTO-1] asignar en la PC sin internet, avisar al volver, y que la nube vuelva a mandar ----
  nube.estado.caida = true;
  const asig = await pedir(PG, 'POST', '/asignar', { cuerpo: { estacion: EST_COCINA, transporte: 'TCP', destino: `127.0.0.1:${barra.puerto}` } });
  assert.equal(asig.json.ok, true); assert.equal(asig.json.nube, false);
  let est5 = (await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth })).json.estaciones.find((e) => e.id === EST_COCINA);
  assert.deepEqual([est5.fuente, est5.pendienteNube], ['local', true]);
  const barraAntes = barra.papeles.length;
  const ra1 = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: uuid(), tipo: 'COMANDA', estacion: EST_COCINA, payload: { mesa: '20', items: [] } }, cabeceras: auth });
  assert.equal(ra1.json.ok, true);
  assert.ok(await hasta(() => barra.papeles.length === barraAntes + 1, 3000), 'la asignacion local manda aun sin internet');
  nube.estado.caida = false;
  assert.ok(await hasta(() => nube.estado.asignados.some((a) => a.estacion === EST_COCINA), 25000), 'al volver internet se avisa la asignacion');
  nube.estado.transportes = [{ id: EST_COCINA, transporte: 'TCP', destino: `127.0.0.1:${barra.puerto}` }];   // la nube ya la guardo
  assert.ok(await hasta(async () => {
    const e = (await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth })).json.estaciones.find((x) => x.id === EST_COCINA);
    return e.fuente === 'nube';
  }, 10000), 'confirmada en la nube, la asignacion local se borra');
  // el dueno la cambia desde la app (vuelve a la impresora de cocina): manda la nube
  nube.estado.transportes = [{ id: EST_COCINA, transporte: 'TCP', destino: `127.0.0.1:${cocina.puerto}` }];
  assert.ok(await hasta(async () => {
    const e = (await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth })).json.estaciones.find((x) => x.id === EST_COCINA);
    return e.via === `TCP 127.0.0.1:${cocina.puerto}`;
  }, 10000), 'el cambio de la nube llega al agente');
  const cocinaAntes = cocina.papeles.length; const barraAntes2 = barra.papeles.length;
  const ra2 = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: uuid(), tipo: 'COMANDA', estacion: EST_COCINA, payload: { mesa: '21', items: [] } }, cabeceras: auth });
  assert.equal(ra2.json.ok, true);
  assert.ok(await hasta(() => cocina.papeles.length === cocinaAntes + 1, 3000), 'el ticket va a la impresora NUEVA de la nube');
  assert.equal(barra.papeles.length, barraAntes2);
  nube.estado.transportes = [];

  // ---- 5c) [QA MEDIO-6] desactivado en la consola -> la LAN responde 423 ----
  nube.estado.invalido = true;
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth })).status === 423, 20000), 'con AGENTE_INVALIDO la LAN no imprime');
  assert.equal((await pedir(PL, 'GET', '/v1/hola')).status, 200);
  nube.estado.invalido = false;
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/estado', { cabeceras: auth })).status === 200, 60000), 'reactivado, vuelve a atender');

  // ---- 6) reinicio SIN internet: estaciones y diario sobreviven ----
  await parar(agente);
  nube.estado.caida = true;
  agente = arrancarAgente(env);
  assert.ok(await hasta(async () => (await pedir(PL, 'GET', '/v1/hola').catch(() => ({}))).status === 200, 15000), 'no relevanto:\n' + agente.salida);
  const antes = cocina.papeles.length;
  const r6 = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J1, tipo: 'COMANDA', estacion: EST_COCINA, payload: comanda }, cabeceras: auth });
  assert.equal(r6.json.duplicado, true, 'el diario sobrevive al reinicio');
  const J7 = uuid();
  const r7 = await pedir(PL, 'POST', '/v1/imprimir', { cuerpo: { jobId: J7, tipo: 'PRECUENTA', estacion: EST_COCINA, payload: { mesa: '7', items: [], total: 0, qr: 'x' } }, cabeceras: auth });
  assert.equal(r7.json.ok, true, 'imprime sin internet con las estaciones guardadas: ' + JSON.stringify(r7.json));
  assert.ok(await hasta(() => cocina.papeles.length === antes + 1, 3000));
  assert.match(agente.salida, /estaciones guardadas en esta PC/);

  // ---- 7) [QA BAJO] una sola instancia por carpeta ----
  const segundo = arrancarAgente({ ...env, LEVO_PUERTO_GUI: String(await puertoLibre()), LEVO_PUERTO_LAN: String(await puertoLibre()) });
  const codigo = await new Promise((r) => segundo.once('exit', r));
  assert.equal(codigo, 1);
  assert.match(segundo.salida, /ya esta abierto/);
});
