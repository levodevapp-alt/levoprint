// Pruebas de unidad de las piezas F2 (sin levantar el agente).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const red = require('../lib/red');
const { Diario, claveDeNube, jobIdValido } = require('../lib/diario');
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
  a.poner('job-aaaa-1', { e: 'IMPRIMIENDO', o: 'LAN', est: 'e1' });
  a.poner('job-aaaa-1', { e: 'IMPRESO' });
  a.poner('job-bbbb-2', { e: 'IMPRIMIENDO', o: 'LAN', est: 'e1' });   // "se corta la luz"
  fs.appendFileSync(f, '{"k":"roto",');                                 // linea a medias
  const b = new Diario(f);
  assert.equal(b.estado('job-aaaa-1'), 'IMPRESO');
  assert.equal(b.estado('job-bbbb-2'), 'DUDOSO');
  assert.deepEqual(b.sinReportar().map((x) => x.clave), ['job-aaaa-1']);
  b.marcarReportados(['job-aaaa-1']);
  assert.equal(new Diario(f).sinReportar().length, 0);
  assert.equal(claveDeNube({ id: 9, payload: { jobId: 'abc-12345' } }), 'abc-12345');
  assert.equal(claveDeNube({ id: 9, payload: {} }), 'nube:9');
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
  // freno global: 20 fallos desde IPs distintas anulan el PIN
  e2.nuevoPin();
  for (let i = 0; i < 20; i++) e2.intentar('99999' + (i % 10), 'x', '10.0.0.' + i);
  assert.equal(e2.pinVigente(), null);
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

test('usbwin: clasificar puertos y drivers', () => {
  assert.equal(usbwin.clasificar({ nombre: 'POS-80', puerto: 'USB001', driver: 'POS-80C' }).via, 'USB');
  assert.ok(usbwin.clasificar({ nombre: 'POS-80', puerto: 'USB001', driver: 'POS-80C' }).ticketera);
  assert.equal(usbwin.clasificar({ nombre: 'X', puerto: 'Generic / Text Only', driver: 'Generic / Text Only' }).via, 'OTRA');
  assert.equal(usbwin.clasificar({ nombre: 'PDF', puerto: 'PORTPROMPT:', driver: 'Microsoft Print To PDF' }).via, 'VIRTUAL');
  assert.equal(usbwin.clasificar({ nombre: 'BT', puerto: 'BTHENUM', driver: 'x' }).via, 'BT');
  assert.equal(usbwin.clasificar({ nombre: 'R', puerto: 'IP_192.168.1.80', driver: 'EPSON TM-T20II' }).ipRed, '192.168.1.80');
});

test('transportes: ruta efectiva y TCP real a impresora falsa', async () => {
  assert.deepEqual(transportes.rutaDeEstacion({ ip: '192.168.1.9', puerto: 9100 }), { transporte: 'TCP', destino: '192.168.1.9:9100', fuente: 'ip' });
  assert.equal(transportes.rutaDeEstacion({ ip: '1.2.3.4', transporte: 'USB_WIN', destino: 'POS-80' }).transporte, 'USB_WIN');
  assert.equal(transportes.rutaDeEstacion({ ip: '1.2.3.4' }, { transporte: 'TCP', destino: '10.0.0.5:9100' }).fuente, 'local');
  assert.equal(transportes.rutaDeEstacion({}), null);
  const imp = await impresoraFalsa();
  await transportes.enviar({ transporte: 'TCP', destino: `127.0.0.1:${imp.puerto}` }, '\x1b@HOLA');
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
