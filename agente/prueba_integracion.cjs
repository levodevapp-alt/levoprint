// ============================================================
// LevoPrint · prueba de integración del agente .exe 1.13 (sin Supabase ni impresoras reales)
// ------------------------------------------------------------
//   node agente/prueba_integracion.cjs
// Copia index.js a una carpeta temporal y lo corre como `node index.js` contra:
//   · mock_rpc.cjs (PostgREST falso): KOMO con las RPC de [LP-F3]; KIPU como backend viejo (404 PGRST202).
//   · dos «impresoras» falsas de red en 127.0.0.1:P y 127.0.0.2:P (la búsqueda recorre 127.0.0.x con
//     LEVO_BUSCAR_SUBRED / LEVO_BUSCAR_PUERTO, ajustes que el .exe ignora).
//   · doble_powershell.cjs en vez de powershell.exe (USB de Windows), con una cola que se cuelga.
// Cubre: búsqueda e informe (capacidades, versión, exclusión de PDF/Fax), «Probar» en red y USB,
// elegir destino (red y USB), impresión por transporte, IMPRESORA_EN_OTRO_EQUIPO, buscar:true de la
// consola, RPC ausente → modo 1.12 sin reintentos, guardas 403 de los endpoints nuevos, tiempo máximo
// y reinicio del proceso USB, PowerShell restringido, adopción de komo-agente.txt y retiro de KOMO Agente.
// ============================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { crearMock } = require('./mock_rpc.cjs');

let fallas = 0;
const ok = (c, m, det) => { console.log((c ? 'OK    ' : 'FALLA ') + m + (c || det === undefined ? '' : '\n      ' + String(typeof det === 'string' ? det : JSON.stringify(det)).slice(0, 800))); if (!c) fallas++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms, paso) {
  const fin = Date.now() + ms;
  for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() > fin) return null; await espera(paso || 200); }
}
function puertoLibre() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// Base de la ventana: cada agente revisa base..base+4 buscando «otro LevoPrint abierto»; las bases de los
// agentes de la prueba van separadas (bloques de 10) y con los 5 puertos libres.
const basesUsadas = [];
async function puertoGui() {
  for (let i = 0; i < 200; i++) {
    const base = 20000 + Math.floor(Math.random() * 3000) * 10;
    if (basesUsadas.some((b) => Math.abs(b - base) < 10)) continue;
    let libres = true;
    for (let k = 0; k < 5 && libres; k++) {
      libres = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(base + k, '127.0.0.1', () => s.close(() => r(true))); });
    }
    if (libres) { basesUsadas.push(base); return base; }
  }
  throw new Error('no hay puertos libres para la ventana');
}
// Impresora falsa: guarda todo lo que recibe.
function impresora(host, puerto) {
  const recibido = [];
  const s = net.createServer((c) => { const partes = []; c.on('data', (d) => partes.push(d)); c.on('end', () => { if (partes.length) recibido.push(Buffer.concat(partes).toString('latin1')); }); c.on('error', () => {}); });
  return new Promise((resolve, reject) => { s.once('error', reject); s.listen(puerto, host, () => resolve({ s, recibido })); });
}
async function pedir(base, ruta, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  // fetch no deja cambiar Host: se usa http para las guardas.
  return new Promise((resolve) => {
    const u = new URL(base + ruta);
    const req = require('http').request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { j = null; } resolve({ status: res.statusCode, json: j, texto: d }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (o.body !== undefined) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}
function arrancarAgente(dir, env) {
  fs.copyFileSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'));
  const hijo = spawn(process.execPath, [path.join(dir, 'index.js')], { cwd: dir, env: Object.assign({}, process.env, env), windowsHide: true });
  const log = [];
  hijo.stdout.on('data', (d) => log.push(String(d)));
  hijo.stderr.on('data', (d) => log.push(String(d)));
  return { hijo, log };
}

const DEV_KOMO = '11111111-1111-4111-8111-111111111111';
const DEV_KIPU = '22222222-2222-4222-8222-222222222222';
const DEV_KOMO_ANTIGUO = '33333333-3333-4333-8333-333333333333';
const DEV_OTRO = '44444444-4444-4444-8444-444444444444';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levoprint-int-'));
  const agentes = [];
  try {
    const P = await puertoLibre();
    const imp1 = await impresora('127.0.0.1', P);
    let imp2;
    try { imp2 = await impresora('127.0.0.2', P); } catch (e) { console.error('No se pudo abrir 127.0.0.2 (este sistema no enruta 127.0.0.x): ' + e.message); process.exit(1); }
    const mock = await crearMock({
      apps: {
        komo: {
          devices: [DEV_KOMO, DEV_KOMO_ANTIGUO],
          estaciones: [{ id: 'e1', nombre: 'Cocina' }, { id: 'e2', nombre: 'Caja' }, { id: 'e3', nombre: 'Barra' }],
          estacionVinculo: 'e1',
          // Barra: impresora USB de OTRO equipo (propio = false para este agente).
          destinos: { e3: { transporte: 'usb', usbId: 'POS-58 de la barra', equipo: DEV_OTRO } },
        },
        kipu: { ausente: true, devices: [DEV_KIPU], estaciones: [{ id: 'k1', nombre: 'Caja' }] },
      },
    });
    const salidaUsb = path.join(tmp, 'usb.jsonl');
    const comunes = {
      LEVO_URL: mock.url, LEVO_ANON: 'anon-de-prueba', LEVO_SINVENTANA: '1',
      LEVO_BUSCAR_SUBRED: '127.0.0', LEVO_BUSCAR_PUERTO: String(P),
      LEVO_PRUEBA_PS: path.join(__dirname, 'doble_powershell.cjs'), LP_DOBLE_SALIDA: salidaUsb,
      LEVO_PRUEBA_PS_TIEMPO: '2500', LEVO_PRUEBA_CONFIG_MS: '2500',
    };

    // ---------------- Agente A: KOMO (backend nuevo) + KIPU (backend viejo) ----------------
    const dirA = path.join(tmp, 'a'); fs.mkdirSync(path.join(dirA, 'appdata'), { recursive: true });
    const guiA = await puertoGui();
    const A = arrancarAgente(dirA, Object.assign({}, comunes, {
      LEVO_VINCULOS: 'komo:' + DEV_KOMO + ',kipu:' + DEV_KIPU, LEVO_PUERTO_GUI: String(guiA),
      LEVO_LOCK_DIR: path.join(dirA, 'lock'), APPDATA: path.join(dirA, 'appdata'), LOCALAPPDATA: path.join(dirA, 'local'),
    }));
    agentes.push(A.hijo);
    const baseA = 'http://127.0.0.1:' + guiA;
    ok(!!(await hasta(async () => (await pedir(baseA, '/estado', { headers: { Host: '127.0.0.1:' + guiA } })).json, 10000)), 'la ventana del agente responde /estado');

    // 1) Búsqueda: red (2 falsas) + USB (sin PDF ni Fax), informada a KOMO con versión y capacidades.
    const vistas = await hasta(() => { const v = mock.estado.komo.vistas.get(DEV_KOMO); return v && v.length >= 6 ? v : null; }, 15000);
    const refs = (vistas || []).map((x) => x.transporte + ':' + x.ref).sort();
    ok(refs.includes('red:127.0.0.1:' + P) && refs.includes('red:127.0.0.2:' + P), 'la búsqueda en red encontró las 2 impresoras falsas', refs);
    ok(refs.includes('usb:POS-80 USB') && refs.includes('usb:Caja Ñandú'), 'las colas USB llegan (con tildes)', refs);
    ok(!refs.some((r) => /PDF|Fax/.test(r)), 'PDF y Fax quedan fuera', refs);
    const usbPos = (vistas || []).find((x) => x.ref === 'POS-80 USB');
    ok(!!(usbPos && usbPos.detalle && usbPos.detalle.probableTermica === true && usbPos.detalle.modelo === 'POS-80C'), 'POS-80 sale como probable térmica con su modelo', usbPos);
    const llamadaImp = mock.llamadas.filter((l) => l.prefijo === 'komo' && l.fn === 'agente_impresoras' && l.p && l.p.encontradas).pop();
    ok(!!llamadaImp && llamadaImp.p.version === 'exe/1.13' && llamadaImp.p.capacidades.join(',') === 'red,usb' && llamadaImp.p.equipo === os.hostname().slice(0, 60), 'agente_impresoras lleva versión exe/1.13, capacidades red+usb y el equipo', llamadaImp && llamadaImp.p);
    const cfgCall = mock.llamadas.find((l) => l.prefijo === 'komo' && l.fn === 'agente_config');
    ok(!!cfgCall && cfgCall.p.version === 'exe/1.13', 'agente_config se sigue llamando (con la versión)');

    // 2) KIPU sin las RPC: una sola llamada (modo 1.12 por 30 min), aunque pasen varios ciclos de config.
    await espera(6000);
    const kipuImp = () => mock.llamadas.filter((l) => l.prefijo === 'kipu' && l.fn === 'agente_impresoras').length;
    ok(kipuImp() === 1, 'KIPU: agente_impresoras ausente → no se reintenta (modo 1.12)', kipuImp());
    ok(mock.llamadas.filter((l) => l.prefijo === 'kipu' && l.fn === 'agente_config').length >= 2, 'KIPU sigue con agente_config en cada ciclo');

    // 3) Guardas: mismas que el resto del servidor local.
    const H = { Host: '127.0.0.1:' + guiA };
    ok((await pedir(baseA, '/impresoras', { headers: { Host: 'evil.example:' + guiA } })).status === 403, 'GET /impresoras con Host ajeno → 403');
    ok((await pedir(baseA, '/buscar', { headers: { Host: '127.0.0.1:' + guiA, Origin: 'http://evil.example' }, body: {} })).status === 403, 'POST /buscar con Origin ajeno → 403');
    ok((await pedir(baseA, '/probar-destino', { headers: { Host: '127.0.0.1:' + guiA, 'Content-Type': 'text/plain' }, body: '{"transporte":"red","ref":"127.0.0.2:' + P + '"}' })).status === 403, 'POST /probar-destino con text/plain → 403');
    ok((await pedir(baseA, '/elegir', { headers: { Host: 'localhost.evil:' + guiA }, body: {} })).status === 403, 'POST /elegir con Host rebindeado → 403');
    ok((await pedir(baseA, '/komo-agente/retirar', { headers: { Host: '127.0.0.1:' + guiA, Origin: 'null' }, body: {} })).status === 403, 'POST /komo-agente/retirar con Origin null → 403');
    ok(imp2.recibido.length === 0, 'nada se imprimió por las peticiones rechazadas');

    // 4) GET /impresoras y «Probar» en red y en USB.
    const lista = (await pedir(baseA, '/impresoras', { headers: H })).json;
    ok(!!lista && lista.red.length === 2 && lista.usb.length === 4, 'GET /impresoras: 2 de red y 4 USB', lista);
    let r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', estacion: 'e1', transporte: 'red', ref: '127.0.0.2:' + P } })).json;
    ok(!!r && r.ok === true, 'probar-destino red responde ok', r);
    ok(!!(await hasta(() => imp2.recibido.some((t) => t.includes('PRUEBA LEVOPRINT OK')), 4000)), 'la impresora 127.0.0.2 recibió el papel de prueba');
    ok(!imp1.recibido.some((t) => t.includes('PRUEBA')), 'la otra impresora no recibió nada');
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'usb', ref: 'Caja Ñandú' } })).json;
    const usbLineas = () => (fs.existsSync(salidaUsb) ? fs.readFileSync(salidaUsb, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    ok(!!r && r.ok === true && usbLineas().some((x) => x.cola === 'Caja Ñandú' && x.texto.includes('PRUEBA LEVOPRINT OK')), 'probar-destino USB llega a la cola correcta (con tildes)', r);
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'usb', ref: 'Cola inventada' } })).json;
    ok(!!r && r.ok === false && r.error === 'DESTINO_INVALIDO', 'probar-destino rechaza una cola que la búsqueda no vio', r);
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'red', ref: '999.1.1.1' } })).json;
    ok(!!r && r.error === 'DESTINO_INVALIDO', 'probar-destino rechaza una IP mal formada', r);

    // 5) Elegir destino: red para Cocina, USB para Caja.
    r = (await pedir(baseA, '/elegir', { headers: H, body: { prefijo: 'komo', estacion: 'e1', transporte: 'red', ref: '127.0.0.2:' + P } })).json;
    ok(!!r && r.ok === true, 'elegir Cocina → red 127.0.0.2', r);
    const elegido = mock.estado.komo.elegidos[0] || {};
    ok(elegido.device === DEV_KOMO && elegido.ip === '127.0.0.2' && elegido.puerto === P && elegido.transporte === 'red', 'agente_estacion_elegir recibe device, ip y puerto', elegido);
    r = (await pedir(baseA, '/elegir', { headers: H, body: { prefijo: 'komo', estacion: 'e2', transporte: 'usb', ref: 'POS-80 USB' } })).json;
    ok(!!r && r.ok === true, 'elegir Caja → USB «POS-80 USB»', r);
    r = (await pedir(baseA, '/elegir', { headers: H, body: { prefijo: 'komo', estacion: 'no-existe', transporte: 'red', ref: '127.0.0.2:' + P } })).json;
    ok(!!r && r.ok === false && r.error === 'ESTACION_NO_EXISTE', 'elegir con una estación desconocida avisa', r);
    const est = (await pedir(baseA, '/estado', { headers: H })).json;
    const komoEst = ((est && est.vinculos) || []).find((v) => v.prefijo === 'komo') || { estaciones: [] };
    const cocina = komoEst.estaciones.find((x) => x.id === 'e1') || {}, caja = komoEst.estaciones.find((x) => x.id === 'e2') || {}, barra = komoEst.estaciones.find((x) => x.id === 'e3') || {};
    ok(cocina.imprimible && /Red: 127\.0\.0\.2/.test(cocina.destino) && caja.imprimible && /USB en esta PC: POS-80 USB/.test(caja.destino), '/estado muestra el destino de cada estación', komoEst.estaciones);
    ok(barra.imprimible === false && /otro equipo/.test(barra.destino), 'Barra (USB de otro equipo) no es imprimible aquí', barra);

    // 6) Trabajos de la cola por transporte + IMPRESORA_EN_OTRO_EQUIPO.
    const antesUsb = usbLineas().length;
    mock.estado.komo.jobs.push(
      { id: 'j1', estacion: 'e1', tipo: 'COMANDA', payload: { mesa: '7', mozo: 'Ana', hora: '12:00', items: [{ cantidad: 1, nombre: 'Lomo saltado' }] } },
      { id: 'j2', estacion: 'e2', tipo: 'TICKET', payload: { negocio: 'Mi tienda', hora: '12:01', items: [{ cantidad: 2, nombre: 'Agua', precio: 2.5 }], total: 5, pagos: [{ medio: 'Efectivo', monto: 5 }] } },
      { id: 'j3', estacion: 'e3', tipo: 'COMANDA', payload: { mesa: '1', items: [] } },
    );
    const marc = await hasta(() => (mock.estado.komo.marcados.length >= 3 ? mock.estado.komo.marcados : null), 15000);
    const m = (id) => (marc || []).find((x) => x.id === id) || {};
    ok(m('j1').ok === true && imp2.recibido.some((t) => t.includes('MESA 7') && t.includes('Lomo saltado')), 'COMANDA de Cocina sale por la red (127.0.0.2)', marc);
    ok(m('j2').ok === true && usbLineas().slice(antesUsb).some((x) => x.cola === 'POS-80 USB' && x.texto.includes('Agua')), 'TICKET de Caja sale por la cola USB', marc);
    ok(m('j3').ok === false && /^IMPRESORA_EN_OTRO_EQUIPO/.test(m('j3').error || ''), 'trabajo de una USB de otro equipo → IMPRESORA_EN_OTRO_EQUIPO', m('j3'));

    // 7) KIPU (backend viejo): elegir devuelve el modo 1.12 «Escribe esta IP en…».
    r = (await pedir(baseA, '/elegir', { headers: H, body: { prefijo: 'kipu', estacion: 'k1', transporte: 'red', ref: '127.0.0.1:' + P } })).json;
    ok(!!r && r.ok === false && r.modo112 === true && /Escribe esta IP en tu consola de KIPU/.test(r.mensaje) && r.mensaje.includes('127.0.0.1'), 'KIPU sin RPC: «Escribe esta IP en tu consola de KIPU…»', r);
    ok(mock.llamadas.filter((l) => l.prefijo === 'kipu' && l.fn === 'agente_estacion_elegir').length === 0, 'KIPU en modo 1.12 no llama a agente_estacion_elegir');

    // 8) La consola pide buscar (buscar:true) → el agente busca y responde con «buscado».
    const nAntes = mock.llamadas.length;
    mock.estado.komo.buscar = true;
    const buscado = await hasta(() => mock.llamadas.slice(nAntes).find((l) => l.prefijo === 'komo' && l.fn === 'agente_impresoras' && l.p && l.p.buscado === true && Array.isArray(l.p.encontradas)), 15000);
    ok(!!buscado && mock.estado.komo.buscar === false, 'buscar:true de la consola → búsqueda y respuesta con buscado + encontradas');
    ok(kipuImp() === 1, 'KIPU sigue sin reintentos tras otra búsqueda', kipuImp());

    // 9) POST /buscar desde la ventana devuelve la lista.
    r = (await pedir(baseA, '/buscar', { headers: H, body: {} })).json;
    ok(!!r && r.ok === true && r.red.length === 2 && r.buscando === false, 'POST /buscar devuelve lo encontrado', r);

    // 10) USB que no responde: tiempo máximo, error claro y el proceso se reabre para el siguiente.
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'usb', ref: 'CUELGA' } })).json;
    ok(!!r && r.ok === false && r.error === 'USB_TIEMPO', 'cola USB colgada → USB_TIEMPO (tiempo máximo)', r);
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'usb', ref: 'CUELGA_AL_CERRAR' } })).json;
    ok(!!r && r.ok === true, 'datos ya escritos y Windows trabado al cerrar → se da por impreso (sin duplicar)', r);
    const pidsAntes = new Set(usbLineas().map((x) => x.pid));
    r = (await pedir(baseA, '/probar-destino', { headers: H, body: { prefijo: 'komo', transporte: 'usb', ref: 'POS-80 USB' } })).json;
    const ultima = usbLineas().pop() || {};
    ok(!!r && r.ok === true && !pidsAntes.has(ultima.pid), 'tras colgarse, el proceso USB se reinicia y vuelve a imprimir', { r, ultima: ultima.pid, antes: [...pidsAntes] });

    // ---------------- Agente B: PowerShell restringido + komo-agente.txt + KOMO Agente en el arranque ----------------
    const dirB = path.join(tmp, 'b');
    const inicioB = path.join(dirB, 'appdata', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    fs.mkdirSync(inicioB, { recursive: true });
    const lnk = path.join(inicioB, 'KOMO Agente.lnk');
    fs.writeFileSync(lnk, 'acceso falso');
    fs.writeFileSync(path.join(dirB, 'komo-agente.txt'), '﻿KOMO_URL=' + mock.url + '\r\nKOMO_ANON=x\r\nKOMO_DEVICE=' + DEV_KOMO_ANTIGUO + '\r\n');
    const guiB = await puertoGui();
    const B = arrancarAgente(dirB, Object.assign({}, comunes, {
      LEVO_VINCULOS: '', LEVO_PUERTO_GUI: String(guiB), LP_DOBLE_MODO: 'restringido',
      LEVO_LOCK_DIR: path.join(dirB, 'lock'), APPDATA: path.join(dirB, 'appdata'), LOCALAPPDATA: path.join(dirB, 'local'),
    }));
    agentes.push(B.hijo);
    const baseB = 'http://127.0.0.1:' + guiB, HB = { Host: '127.0.0.1:' + guiB };
    const estB = await hasta(async () => { const e = (await pedir(baseB, '/estado', { headers: HB })).json; return e && e.vinculos && e.vinculos.length ? e : null; }, 10000);
    ok(!!estB && estB.vinculos[0].prefijo === 'komo' && estB.komoAgente && estB.komoAgente.adoptado === true && estB.komoAgente.enInicio === true, 'komo-agente.txt adoptado y «KOMO Agente.lnk» detectado', estB);
    ok(/LEVO_VINCULOS=komo:33333333-3333-4333-8333-333333333333/.test(fs.readFileSync(path.join(dirB, 'levoprint.txt'), 'utf8')), 'el vínculo adoptado queda en levoprint.txt');
    const capB = await hasta(() => mock.llamadas.find((l) => l.fn === 'agente_impresoras' && l.p && l.p.device === DEV_KOMO_ANTIGUO && l.p.encontradas), 15000);
    ok(!!capB && capB.p.capacidades.join(',') === 'red', 'PowerShell restringido → capacidades sin usb', capB && capB.p.capacidades);
    const impB = (await pedir(baseB, '/impresoras', { headers: HB })).json;
    ok(!!impB && impB.usb.length === 0 && /bloquea la impresión USB/.test(impB.usbAviso || ''), 'la ventana avisa que Windows bloquea la impresión USB', impB);
    // Se retira solo cuando LevoPrint ya tomó la cola de KOMO con éxito (print_tomar reciente).
    ok(!!(await hasta(() => mock.llamadas.some((l) => l.fn === 'print_tomar' && l.p && l.p.device === DEV_KOMO_ANTIGUO), 10000)), 'el vínculo adoptado ya toma la cola de KOMO');
    await espera(500);
    r = (await pedir(baseB, '/komo-agente/retirar', { headers: HB, body: {} })).json;
    ok(!!r && r.ok === true && !fs.existsSync(lnk), 'retirar KOMO Agente quita el acceso del arranque', r);
    // Con el vínculo de KOMO desactivado no se cierra KOMO Agente (KOMO dejaría de imprimir): 3.er agente con un token de KOMO que el servidor rechaza.
    const dirC = path.join(tmp, 'c'); fs.mkdirSync(dirC, { recursive: true });
    const guiC = await puertoGui();
    const C = arrancarAgente(dirC, Object.assign({}, comunes, {
      LEVO_VINCULOS: 'kipu:' + DEV_KIPU + ',komo:' + DEV_OTRO, LEVO_PUERTO_GUI: String(guiC),
      LEVO_LOCK_DIR: path.join(dirC, 'lock'), APPDATA: path.join(dirC, 'appdata'), LOCALAPPDATA: path.join(dirC, 'local'),
    }));
    agentes.push(C.hijo);
    const HC = { Host: '127.0.0.1:' + guiC };
    await hasta(async () => { const e = (await pedir('http://127.0.0.1:' + guiC, '/estado', { headers: HC })).json; return e && (e.vinculos || []).some((v) => v.prefijo === 'komo' && v.desactivado); }, 10000);
    r = (await pedir('http://127.0.0.1:' + guiC, '/komo-agente/retirar', { headers: HC, body: {} })).json;
    ok(!!r && r.ok === false && r.error === 'KOMO_DESACTIVADO', 'con KOMO desactivado no se cierra KOMO Agente', r);

    await mock.close();
    imp1.s.close(); imp2.s.close();
    if (fallas) { console.log('\n--- log agente A ---\n' + A.log.join('').slice(-4000)); console.log('\n--- log agente B ---\n' + B.log.join('').slice(-3000)); }
  } catch (e) {
    console.error('FALLA inesperada: ' + (e && e.stack || e));
    fallas++;
  } finally {
    for (const h of agentes) { try { h.kill(); } catch { /* ya cerró */ } }
    await espera(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows puede tener el log abierto un instante */ }
  }
  console.log(fallas ? '\nintegración del agente: ' + fallas + ' FALLA(S)' : '\nintegración del agente: todo OK');
  process.exit(fallas ? 1 : 0);
})();
