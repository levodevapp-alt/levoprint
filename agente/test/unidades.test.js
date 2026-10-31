// Pruebas de unidad de las piezas F2 (sin levantar el agente).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const red = require('../lib/red');
const { Diario, claveDe, claveDeNube, jobIdDeNube, jobIdValido } = require('../lib/diario');
const { Motor } = require('../lib/motor');
const { renderPara } = require('../lib/render');
const { Colas } = require('../lib/colas');
const { Emparejador } = require('../lib/emparejar');
const mdns = require('../lib/mdns');
const usbwin = require('../lib/usbwin');
const transportes = require('../lib/transportes');
const { barrerLan } = require('../lib/buscar');
const { impresoraFalsa } = require('./util/falsos');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lp-u-'));

test('red: IP privada, host y origen', () => {
  for (const ip of ['192.168.1.5', '10.0.0.2', '172.16.3.4', '127.0.0.1', '::1', '::ffff:192.168.0.9', 'fe80::1', 'fd12::3', '169.254.1.1']) assert.ok(red.esIpPrivada(ip), ip);
  for (const ip of ['8.8.8.8', '100.64.1.1', '172.32.0.1', '2800:200::1', '::ffff:1.1.1.1']) assert.ok(!red.esIpPrivada(ip), ip);
  assert.ok(red.hostPermitido('192.168.1.20:9120'));
  assert.ok(red.hostPermitido('localhost:9120'));
  assert.ok(red.hostPermitido('caja.local'));
  assert.ok(!red.hostPermitido('evil.com:9120'));
  assert.ok(!red.hostPermitido(''));
  assert.ok(red.origenPermitido('https://komo.levodev.app'));
  assert.ok(red.origenPermitido('https://levodev.app'));
  assert.ok(!red.origenPermitido('http://komo.levodev.app'));
  assert.ok(!red.origenPermitido('https://levodev.app.evil.com'));
  assert.ok(!red.origenPermitido('https://evillevodev.app'));
  assert.ok(red.origenPermitido('http://localhost:5173', ['http://localhost:5173']));
});

test('diario: dedupe, persistencia, DUDOSO y reporte', () => {
  const d = tmp(); const f = path.join(d, 'diario.jsonl');
  const a = new Diario(f);
  const k1 = claveDe('job-aaaa-1', 'e1'), k2 = claveDe('job-bbbb-2', 'e1');
  a.poner(k1, { e: 'IMPRIMIENDO', o: 'LAN', j: 'job-aaaa-1', est: 'e1' });
  a.poner(k1, { e: 'IMPRESO' });
  a.poner(k2, { e: 'IMPRIMIENDO', o: 'LAN', j: 'job-bbbb-2', est: 'e1' });   // "se corta la luz"
  fs.appendFileSync(f, '{"k":"roto",');                                       // linea a medias
  const b = new Diario(f);
  assert.equal(b.estado(k1), 'IMPRESO');
  assert.equal(b.estado(k2), 'DUDOSO');
  assert.deepEqual(b.sinReportar().map((x) => [x.clave, x.estacion]), [['job-aaaa-1', 'e1']]);
  b.marcarReportados(b.sinReportar().map((x) => x.k));
  assert.equal(new Diario(f).sinReportar().length, 0);
  assert.equal(k1, 'job-aaaa-1|e1');
  assert.equal(claveDeNube({ id: 9, estacion: 'e2', payload: { jobId: 'abc-12345' } }), 'abc-12345|e2');
  assert.equal(jobIdDeNube({ id: 9, payload: {} }), 'nube:9');
  assert.ok(jobIdValido('4f1c2b9e-1111-4222-8333-944455556666'));
  assert.ok(!jobIdValido('corto'));
  assert.ok(!jobIdValido('nube:12345678'));
  assert.ok(!jobIdValido('con espacio 12345'));
});

test('diario: retencion de 7 dias', () => {
  const d = tmp(); const f = path.join(d, 'diario.jsonl');
  fs.writeFileSync(f, JSON.stringify({ k: 'viejo-123456', e: 'IMPRESO', ts: Date.now() - 8 * 86400000 }) + '\n' + JSON.stringify({ k: 'nuevo-123456', e: 'IMPRESO', ts: Date.now() }) + '\n');
  const a = new Diario(f);
  assert.equal(a.get('viejo-123456'), null);
  assert.equal(a.estado('nuevo-123456'), 'IMPRESO');
});

test('colas: misma impresora en orden, otra impresora no espera, tope de tiempo', async () => {
  const c = new Colas({ timeoutMs: 300 });
  const orden = [];
  const lento = (n, ms) => () => new Promise((r) => setTimeout(() => { orden.push(n); r(n); }, ms));
  const t0 = Date.now();
  const p1 = c.encolar('A', lento('a1', 120));
  const p2 = c.encolar('A', lento('a2', 10));
  const p3 = c.encolar('B', lento('b1', 10));
  await p3;
  assert.ok(Date.now() - t0 < 100, 'B no espero a A');
  await Promise.all([p1, p2]);
  assert.deepEqual(orden, ['b1', 'a1', 'a2']);
  await assert.rejects(c.encolar('A', () => new Promise(() => {})), /no respondio/);
  assert.equal(await c.encolar('A', lento('a3', 5)), 'a3');      // la cola sigue tras el colgado
});

test('emparejar: PIN de un uso, token valido, freno por IP y global', () => {
  const d = tmp(); const f = path.join(d, 'equipos.json');
  const e = new Emparejador(f);
  assert.equal(e.intentar('123456', 'Caja', '192.168.1.9').error, 'SIN_PIN');
  const pin = e.nuevoPin().valor;
  const malo = pin === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal(e.intentar(malo, 'x', '192.168.1.66').error, 'PIN_INVALIDO');
  assert.equal(e.intentar(malo, 'x', '192.168.1.66').error, 'PIN_INVALIDO');        // 5o fallo: bloquea
  assert.equal(e.intentar(pin, 'x', '192.168.1.66').error, 'ESPERA');
  const ok = e.intentar(pin, 'Caja 1 <b>', '192.168.1.9');
  assert.ok(ok.ok && ok.token);
  assert.equal(ok.equipo.nombre, 'Caja 1 b');
  assert.equal(e.intentar(pin, 'Otra', '192.168.1.9').error, 'SIN_PIN');            // un solo uso
  const e2 = new Emparejador(f);                                                      // persistido
  assert.ok(e2.validar(ok.token));
  assert.equal(e2.validar(ok.token + 'x'), null);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(ok.token), 'el archivo no guarda el token');
  assert.ok(e2.quitar(ok.equipo.id));
  assert.equal(e2.validar(ok.token), null);
  // [QA BAJO] freno global: 30 fallos por minuto frenan a TODOS, pero NO anulan el PIN
  const pin2 = e2.nuevoPin().valor;
  const otro = pin2 === '999999' ? '888888' : '999999';
  for (let i = 0; i < 30; i++) e2.intentar(otro, 'x', '10.0.0.' + i);
  assert.ok(e2.pinVigente(), 'el PIN sigue vigente');
  assert.equal(e2.intentar(pin2, 'Caja', '10.0.1.1').error, 'ESPERA');
  e2.fallosGlobal = [];                                  // pasa el minuto
  assert.ok(e2.intentar(pin2, 'Caja', '10.0.1.1').ok);
  // [re-QA] 150 fallos acumulados contra el mismo PIN lo anulan
  const pin3 = e2.nuevoPin().valor;
  const malo3 = pin3 === '777777' ? '666666' : '777777';
  for (let i = 0; i < 149; i++) { e2.fallosGlobal = []; e2.porIp.clear(); e2.intentar(malo3, 'x', '10.0.2.' + (i % 250)); }
  assert.ok(e2.pinVigente(), '149 fallos: sigue');
  e2.fallosGlobal = []; e2.porIp.clear();
  assert.equal(e2.intentar(malo3, 'x', '10.0.3.1').error, 'SIN_PIN');
  assert.equal(e2.pinVigente(), null, 'al fallo 150 se anula');
});

test('emparejar: token vence a los 90 dias y se renueva al usarse; hash raro se descarta', () => {
  const d = tmp(); const f = path.join(d, 'equipos.json');
  const e = new Emparejador(f);
  const ok = e.intentar(e.nuevoPin().valor, 'Caja', '192.168.1.9');
  const eq = e.equipos[0];
  assert.ok(eq.vence > Date.now() + 89 * 86400000);
  eq.visto = Date.now() - 2 * 60000; eq.vence = Date.now() + 1000;
  assert.ok(e.validar(ok.token));
  assert.ok(e.equipos[0].vence > Date.now() + 89 * 86400000, 'el uso lo renueva');
  e.equipos[0].vence = Date.now() - 1;
  assert.equal(e.validar(ok.token), null, 'vencido no entra');
  assert.equal(e.equipos.length, 0);
  fs.writeFileSync(f, JSON.stringify({ equipos: [{ id: 'a', hash: 'corto' }, { id: 'b', hash: 'f'.repeat(64), creado: Date.now() }] }));
  assert.deepEqual(new Emparejador(f).equipos.map((x) => x.id), ['b']);
});

test('mdns: arma consulta y resuelve SRV + A', () => {
  const q = mdns.armarConsulta(mdns.SERVICIOS);
  assert.equal(q.readUInt16BE(4), 2);
  // Respuesta sintetica: PTR -> instancia, SRV -> host:9100, A -> IP
  const nb = mdns.nombreABytes;
  const rr = (nombre, tipo, datos) => { const h = Buffer.alloc(10); h.writeUInt16BE(tipo, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(datos.length, 8); return Buffer.concat([nb(nombre), h, datos]); };
  const srvDatos = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x23, 0x8c]), nb('epson.local')]);
  const cab = Buffer.alloc(12); cab.writeUInt16BE(0x8400, 2); cab.writeUInt16BE(1, 6); cab.writeUInt16BE(2, 10);
  const pkt = Buffer.concat([cab,
    rr('_pdl-datastream._tcp.local', mdns.T.PTR, nb('EPSON TM-T20._pdl-datastream._tcp.local')),
    rr('EPSON TM-T20._pdl-datastream._tcp.local', mdns.T.SRV, srvDatos),
    rr('epson.local', mdns.T.A, Buffer.from([192, 168, 1, 50]))]);
  const r = mdns.resolver(mdns.parsear(pkt));
  assert.deepEqual(r, [{ nombre: 'EPSON TM-T20', ip: '192.168.1.50', puerto: 9100, servicio: '_pdl-datastream._tcp.local' }]);
});

test('usbwin [re-QA]: todo script que va por stdin a PowerShell es ASCII puro', () => {
  const textos = { PRE: usbwin.PRE, ...usbwin.SCRIPTS };
  assert.ok(Object.keys(usbwin.SCRIPTS).length >= 2, 'estan SCRIPT_LISTAR y SCRIPT_IMPRIMIR');
  for (const [nombre, t] of Object.entries(textos)) {
    const malos = [...t].filter((c) => c.charCodeAt(0) > 127 || (c.charCodeAt(0) < 32 && !'\r\n\t'.includes(c)));
    assert.deepEqual(malos, [], nombre + ' tiene caracteres fuera de ASCII');
  }
});

test('usbwin: clasificar puertos y drivers', () => {
  assert.equal(usbwin.clasificar({ nombre: 'POS-80', puerto: 'USB001', driver: 'POS-80C' }).via, 'USB');
  assert.ok(usbwin.clasificar({ nombre: 'POS-80', puerto: 'USB001', driver: 'POS-80C' }).ticketera);
  assert.equal(usbwin.clasificar({ nombre: 'X', puerto: 'Generic / Text Only', driver: 'Generic / Text Only' }).via, 'OTRA');
  assert.equal(usbwin.clasificar({ nombre: 'PDF', puerto: 'PORTPROMPT:', driver: 'Microsoft Print To PDF' }).via, 'VIRTUAL');
  assert.equal(usbwin.clasificar({ nombre: 'BT', puerto: 'BTHENUM', driver: 'x' }).via, 'BT');
  assert.equal(usbwin.clasificar({ nombre: 'R', puerto: 'IP_192.168.1.80', driver: 'EPSON TM-T20II' }).ipRed, '192.168.1.80');
});

test('transportes: ruta efectiva y TCP real a impresora falsa', async () => {
  assert.deepEqual(transportes.rutaDeEstacion({ ip: '192.168.1.9', puerto: 9100 }), { transporte: 'TCP', destino: '192.168.1.9:9100', fuente: 'nube' });
  assert.equal(transportes.rutaDeEstacion({ ip: '1.2.3.4', transporte: 'USB_WIN', destino: 'POS-80' }).transporte, 'USB_WIN');
  assert.equal(transportes.rutaDeEstacion({ ip: '1.2.3.4' }, { transporte: 'TCP', destino: '10.0.0.5:9100' }).fuente, 'local');
  assert.equal(transportes.rutaDeEstacion({}), null);
  // [QA MEDIO-4] un solo punto de validacion
  for (const [d, ok] of [['192.168.1.9:9100', true], ['10.0.0.5', true], ['172.20.1.1:9103', true], ['192.168.1.9:22', false],
    ['192.168.1.9:631', false], ['127.0.0.1:9100', false], ['169.254.1.1:9100', false], ['8.8.8.8:9100', false], ['impresora.local:9100', false]]) {
    assert.equal(transportes.validarDestino('TCP', d) === null, ok, d);
  }
  assert.equal(transportes.validarDestino('USB_WIN', 'POS-80 (copia 1)'), null);
  await assert.rejects(transportes.enviar({ transporte: 'TCP', destino: '127.0.0.1:22' }, 'x'), (e) => e.sinEnviar && e.codigo === 'DESTINO_NO_PERMITIDO');
  // conexion rechazada = sinEnviar (nada salio)
  process.env.LEVO_TCP_PRUEBAS = '1';
  await assert.rejects(transportes.enviar({ transporte: 'TCP', destino: '127.0.0.1:1' }, 'x'), (e) => e.sinEnviar === true);
  assert.match(transportes.mensajePublico({ sinEnviar: true, message: 'connect ECONNREFUSED 127.0.0.1:1' }), /No se pudo conectar/);
  assert.doesNotMatch(transportes.mensajePublico({ message: 'EPIPE 10.0.0.1' }), /EPIPE/);
  const imp = await impresoraFalsa();
  await transportes.enviar({ transporte: 'TCP', destino: `127.0.0.1:${imp.puerto}` }, '\x1b@HOLA');
  delete process.env.LEVO_TCP_PRUEBAS;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(imp.textos()[0], '\x1b@HOLA');
  await assert.rejects(transportes.enviar({ transporte: 'BT', destino: 'AA:BB' }, 'x'), /APK/);
  await imp.cerrar();
});

test('barrido LAN encuentra la impresora falsa', async () => {
  const imp = await impresoraFalsa();
  const r = await barrerLan({ hosts: ['127.0.0.1', '127.0.0.2'], puerto: imp.puerto, timeoutMs: 200 });
  assert.deepEqual(r, [{ ip: '127.0.0.1', puerto: imp.puerto }]);
  await imp.cerrar();
});

// ---------- Motor (QA F2) ----------
function motorDePrueba(enviar) {
  const d = tmp();
  const m = new Motor({
    diario: new Diario(path.join(d, 'diario.jsonl')), colas: new Colas({ timeoutMs: 2000 }), renderPara, getAncho: () => 48,
    log: () => {}, logErr: () => {}, enviar,
    archivoEstaciones: path.join(d, 'est.json'), archivoAsignaciones: path.join(d, 'asig.json'),
  });
  m.ponerEstaciones([{ id: 'coc', nombre: 'Cocina', ip: '192.168.1.40', puerto: 9100 }, { id: 'bar', nombre: 'Barra', ip: '192.168.1.41', puerto: 9100 }], 'komo');
  return m;
}
const comanda = (extra) => ({ jobId: 'J1-aaaa-bbbb', origen: 'LAN', estacion: 'coc', tipo: 'COMANDA', payload: { mesa: '7', items: [{ cantidad: 1, nombre: 'Ceviche' }], ...(extra || {}) } });

test('motor [MEDIO-1]: falla A MITAD del envio -> DUDOSO y el reintento sale con sello REIMPRESION', async () => {
  const textos = [];
  let falla = true;
  const m = motorDePrueba(async (ruta, texto) => { if (falla) throw new Error('write EPIPE'); textos.push(texto); });
  const r1 = await m.procesar(comanda());
  assert.equal(r1.ok, false); assert.equal(r1.dudoso, true);
  assert.doesNotMatch(r1.error, /EPIPE/, 'la app no ve el error crudo');
  assert.equal(m.diario.estado(claveDe('J1-aaaa-bbbb', 'coc')), 'DUDOSO');
  falla = false;
  const r2 = await m.procesar(comanda());
  assert.equal(r2.ok, true);
  assert.match(textos[0], /\*\*\* REIMPRESION \*\*\*/);
});

test('motor [MEDIO-1]: conexion rechazada (nada salio) -> ERROR y el reintento sale SIN sello', async () => {
  const textos = [];
  let falla = true;
  const m = motorDePrueba(async (ruta, texto) => { if (falla) { const e = new Error('connect ECONNREFUSED'); e.sinEnviar = true; throw e; } textos.push(texto); });
  const r1 = await m.procesar(comanda());
  assert.equal(r1.dudoso, false);
  assert.equal(m.diario.estado(claveDe('J1-aaaa-bbbb', 'coc')), 'ERROR');
  falla = false;
  await m.procesar(comanda());
  assert.doesNotMatch(textos[0], /REIMPRESION/);
});

test('motor [MEDIO-2]: un jobId por papel y estacion', async () => {
  const salidas = [];
  const m = motorDePrueba(async (ruta) => { salidas.push(ruta.destino); });
  assert.equal((await m.procesar(comanda())).ok, true);
  assert.equal((await m.procesar({ ...comanda(), estacion: 'bar' })).ok, true, 'mismo jobId en OTRA estacion = otro papel');
  assert.equal((await m.procesar(comanda())).duplicado, true);
  assert.deepEqual(salidas, ['192.168.1.40:9100', '192.168.1.41:9100']);
});

test('motor [re-QA NUEVO-1]: reimpresion con el MISMO jobId por la LAN y luego por la nube = UN papel', async () => {
  const salidas = [];
  const m = motorDePrueba(async (ruta) => { salidas.push(ruta.destino); });
  const reimp = { ...comanda({ reimpresion: true }), jobId: 'R1-reimp-0001' };
  assert.equal((await m.procesar(reimp)).ok, true);                                  // sale por la LAN
  const r = await m.procesar({ ...reimp, origen: 'NUBE' });                          // la nube la entrega despues
  assert.equal(r.duplicado, true);
  assert.equal(salidas.length, 1, 'reimpresion:true NO salta la dedupe');
  // una reimpresion de verdad lleva un jobId NUEVO y si sale
  assert.equal((await m.procesar({ ...reimp, jobId: 'R2-reimp-0002' })).ok, true);
  assert.equal(salidas.length, 2);
});

test('motor [re-QA A->B->A]: la pendiente compara la VERSION de la nube, no el valor', () => {
  const m = motorDePrueba(async () => {});
  m.ponerTransportes([{ id: 'coc', transporte: 'TCP', destino: '192.168.1.40:9100', v: 4 }]);
  m.asignar('coc', 'TCP', '192.168.1.99:9100', { pendienteNube: true });
  assert.deepEqual(m.asignaciones.coc.nubeAntes, { transporte: 'TCP', destino: '192.168.1.40:9100', v: 4 });
  m.ponerTransportes([{ id: 'coc', transporte: 'TCP', destino: '192.168.1.40:9100', v: 4 }]);
  assert.equal(m.ruta('coc').fuente, 'local', 'misma version: la pendiente se queda');
  // el dueno paso A -> B -> A: mismo valor, version 6
  m.ponerTransportes([{ id: 'coc', transporte: 'TCP', destino: '192.168.1.40:9100', v: 6 }]);
  assert.equal(m.asignaciones.coc, undefined, 'A->B->A: se descarta aunque el valor coincida');
  assert.equal(m.ruta('coc').destino, '192.168.1.40:9100');
  // la nube acepta una asignacion y devuelve la version nueva: la siguiente parte de ella
  m.asignar('coc', 'TCP', '192.168.1.98:9100', { pendienteNube: true });
  m.confirmarNube('coc', 7);
  m.asignar('coc', 'TCP', '192.168.1.97:9100', { pendienteNube: true });
  assert.equal(m.asignaciones.coc.nubeAntes.v, 7);
});

test('colas [re-QA]: si el tope vence antes de mandar, la tarea ve abandonada y no manda', async () => {
  const c = new Colas({ timeoutMs: 100 });
  let mandado = false;
  await assert.rejects(c.encolar('A', async (estado) => {
    await new Promise((r) => setTimeout(r, 200));            // render lento
    if (estado.abandonada) return;
    mandado = true;
  }), /no respondio/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mandado, false);
});

test('motor [re-QA ALTO-1]: asignacion pendiente se descarta si la nube cambio desde que se asigno', () => {
  const m = motorDePrueba(async () => {});
  m.asignar('coc', 'TCP', '192.168.1.99:9100', { pendienteNube: true });   // la nube tenia null (ip de siempre)
  m.ponerTransportes([{ id: 'coc', transporte: null, destino: null }]);
  assert.equal(m.ruta('coc').fuente, 'local', 'la nube sigue igual que al asignar: la pendiente se queda');
  m.ponerTransportes([{ id: 'coc', transporte: 'TCP', destino: '192.168.1.77:9100' }]);
  assert.equal(m.asignaciones.coc, undefined, 'el dueno cambio la impresora en la app despues: se descarta la local');
  assert.equal(m.ruta('coc').destino, '192.168.1.77:9100');
  m.asignar('bar', 'TCP', '192.168.1.98:9100', { pendienteNube: true });
  assert.deepEqual(m.asignaciones.bar.nubeAntes, { transporte: null, destino: null, v: null });
  m.descartarPorNube('bar');                                                 // el servidor respondio CAMBIO_EN_NUBE
  assert.equal(m.asignaciones.bar, undefined);
});

test('motor [ALTO-1]: asignacion local pendiente manda; confirmada se borra; la nube vuelve a mandar', () => {
  const m = motorDePrueba(async () => {});
  m.asignar('coc', 'TCP', '192.168.1.99:9100', { pendienteNube: true });
  assert.equal(m.ruta('coc').fuente, 'local');
  m.ponerTransportes([{ id: 'coc', transporte: null, destino: null }]);
  assert.equal(m.ruta('coc').destino, '192.168.1.99:9100', 'pendiente: la nube vieja no la pisa');
  m.confirmarNube('coc');
  assert.equal(m.asignaciones.coc, undefined);
  assert.deepEqual([m.ruta('coc').fuente, m.ruta('coc').destino], ['nube', '192.168.1.99:9100']);
  m.ponerTransportes([{ id: 'coc', transporte: 'TCP', destino: '192.168.1.77:9100' }]);
  assert.equal(m.ruta('coc').destino, '192.168.1.77:9100', 'el dueno la cambio en la app: manda la nube');
  // asignacion local YA sincronizada que difiere de la nube: se descarta
  m.asignar('bar', 'USB_WIN', 'POS-80', { pendienteNube: false });
  m.ponerTransportes([{ id: 'bar', transporte: 'TCP', destino: '192.168.1.88:9100' }]);
  assert.equal(m.asignaciones.bar, undefined);
  assert.equal(m.ruta('bar').destino, '192.168.1.88:9100');
  assert.deepEqual(m.listaEstaciones().map((e) => e.fuente), ['nube', 'nube']);
});
