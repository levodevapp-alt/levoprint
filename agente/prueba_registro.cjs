// ============================================================
// LevoPrint · prueba del REGISTRO de apps (D8 · NUC-COM7 · 27-nov), sin Supabase ni impresoras reales
// ------------------------------------------------------------
//   node agente/prueba_registro.cjs        (parte de `npm run prueba`)
// El agente aprende la letra de una app NUEVA desde el servidor (public.levoprint_apps, módulo levoprint_registro de
// levodev-modules; fuente única apps.json → __LP_COD__), sin publicar otro LevoPrint. Con mock_rpc.cjs:
//   R1  con registro: un código W… (KAWA) canjea contra kawa_estacion_codigo_canjear y queda vinculado; la ventana
//       nombra a KAWA; levoprint_apps.json queda guardado. Un registro que intenta pisar K (fábrica) se ignora, y una
//       fila con texto raro (HTML) no entra.
//   R2  letra que nadie conoce (Z): CODIGO_RESERVADO sin llamar a ningún canje.
//   R3  backend SIN el módulo (404): solo las de fábrica; W = CODIGO_RESERVADO (no «revisa tu internet»).
//   R4  sin red para el registro (500) y sin nada guardado: W = RED («no se pudo confirmar…»), sin canje.
//   R5  sin registro (404) pero con levoprint_apps.json guardado: W sigue funcionando (arranque sin red).
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
const basesUsadas = [];
async function puertoGui() {
  for (let i = 0; i < 200; i++) {
    const base = 23000 + Math.floor(Math.random() * 3000) * 10;
    if (basesUsadas.some((b) => Math.abs(b - base) < 10)) continue;
    let libres = true;
    for (let k = 0; k < 5 && libres; k++) {
      libres = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(base + k, '127.0.0.1', () => s.close(() => r(true))); });
    }
    if (libres) { basesUsadas.push(base); return base; }
  }
  throw new Error('no hay puertos libres para la ventana');
}
function pedir(base, ruta, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return new Promise((resolve) => {
    const u = new URL(base + ruta);
    const req = require('http').request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { j = null; } resolve({ status: res.statusCode, json: j, texto: d }); });
    });
    req.on('error', () => resolve({ status: 0, json: null, texto: '' }));
    if (o.body !== undefined) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}
const DEV_KAWA = '55555555-5555-4555-8555-555555555555';
const REGISTRO = {
  ok: true, version: 1, conflictos: [],
  apps: [
    { letra: 'K', prefijo: 'komo', nombre: 'KOMO', seccion: 'Estaciones', activa: true },
    { letra: 'P', prefijo: 'kipu', nombre: 'KIPU', seccion: 'Impresoras', activa: true },
    { letra: 'T', prefijo: 'kuti', nombre: 'KUTI', seccion: 'Impresoras', activa: true },
    { letra: 'W', prefijo: 'kawa', nombre: 'KAWA', seccion: 'Impresoras', activa: false },
    { letra: 'Q', prefijo: 'raro', nombre: '<b>RARO</b>', seccion: 'Impresoras', activa: true },
    { letra: 'K', prefijo: 'pirata', nombre: 'PIRATA', seccion: 'Impresoras', activa: true },
  ],
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levoprint-reg-'));
  const hijos = [];
  let mock;
  function arrancar(nombre, extra) {
    const dir = path.join(tmp, nombre); fs.mkdirSync(path.join(dir, 'appdata'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'));
    fs.cpSync(path.join(__dirname, 'lib'), path.join(dir, 'lib'), { recursive: true });
    if (extra && extra.registroGuardado) fs.writeFileSync(path.join(dir, 'levoprint_apps.json'), extra.registroGuardado);
    return puertoGui().then((gui) => {
      const env = Object.assign({}, process.env, {
        LEVO_URL: mock.url, LEVO_ANON: 'anon-de-prueba', LEVO_SINVENTANA: '1', LEVO_PUERTO_GUI: String(gui),
        LEVO_BUSCAR_SUBRED: '127.0.0', LEVO_BUSCAR_PUERTO: '9', LEVO_PRUEBA_PS: path.join(__dirname, 'doble_powershell.cjs'),
        LP_DOBLE_SALIDA: path.join(dir, 'usb.jsonl'), LEVO_PRUEBA_CONFIG_MS: '2500',
        LEVO_LOCK_DIR: path.join(dir, 'lock'), APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'local'),
      });
      delete env.LEVO_VINCULOS; delete env.LEVO_DEVICE; delete env.KOMO_DEVICE; delete env.LEVO_CODIGO;
      const hijo = spawn(process.execPath, [path.join(dir, 'index.js')], { cwd: dir, env, windowsHide: true });
      const log = []; hijo.stdout.on('data', (d) => log.push(String(d))); hijo.stderr.on('data', (d) => log.push(String(d)));
      hijos.push(hijo);
      const base = 'http://127.0.0.1:' + gui; const H = { Host: '127.0.0.1:' + gui };
      return { dir, base, H, log, hijo };
    });
  }
  const canjes = (pfx) => mock.llamadas.filter((l) => l.fn === 'estacion_codigo_canjear' && (!pfx || l.prefijo === pfx)).length;
  const consultasRegistro = () => mock.llamadas.filter((l) => l.prefijo === 'levoprint' && l.fn === 'apps').length;
  try {
    mock = await crearMock({
      registro: REGISTRO,
      apps: {
        kawa: { devices: [DEV_KAWA], estaciones: [{ id: 'w1', nombre: 'Caseta' }],
          canje: { ok: true, device: DEV_KAWA, prefijo: 'kawa', nombre: 'Caseta', seccion: 'Impresoras', modo: 'nuevo' } },
        komo: { devices: [], estaciones: [] },
      },
    });

    // ---------- R1 ----------
    const A = await arrancar('a');
    ok(!!(await hasta(async () => (await pedir(A.base, '/estado', { headers: A.H })).json, 10000)), 'R1 la ventana del agente responde');
    ok(!!(await hasta(() => consultasRegistro() >= 1, 8000)), 'R1 al arrancar consulta public.levoprint_apps');
    const pag = await hasta(async () => { const t = (await pedir(A.base, '/', { headers: A.H })).texto; return /KAWA/.test(t) ? t : null; }, 5000);
    ok(!!pag && /KOMO, KIPU, KUTI y KAWA/.test(pag) && /KAWA › Impresoras/.test(pag) && !/RARO|PIRATA/.test(pag), 'R1 la ventana nombra a KAWA (del servidor), sin la fila con HTML ni la que pisa K', (pag || '').match(/Imprime los pedidos[^<]*/));
    let r = (await pedir(A.base, '/vincular', { headers: A.H, body: { codigo: 'W-2345-ABCD' } })).json;
    ok(!!r && r.ok === true && r.prefijo === 'kawa' && r.app === 'KAWA', 'R1 un código W… vincula con KAWA sin publicar otro LevoPrint', r);
    ok(canjes('kawa') === 1 && mock.llamadas.find((l) => l.fn === 'estacion_codigo_canjear').p.codigo === 'W2345ABCD', 'R1 el canje fue a kawa_estacion_codigo_canjear con el código normalizado');
    const guardado = JSON.parse(fs.readFileSync(path.join(A.dir, 'levoprint_apps.json'), 'utf8'));
    ok(guardado.apps.some((a) => a.letra === 'W' && a.prefijo === 'kawa') && !guardado.apps.some((a) => a.prefijo === 'raro'), 'R1 levoprint_apps.json guardado (sin la fila inválida)', guardado);
    ok(/LEVO_VINCULOS=kawa:/.test(fs.readFileSync(path.join(A.dir, 'levoprint.txt'), 'utf8')), 'R1 el vínculo de kawa quedó en levoprint.txt');
    // K sigue yendo a komo aunque el registro traiga «K = pirata»
    r = (await pedir(A.base, '/vincular', { headers: A.H, body: { codigo: 'K2345ABCD' } })).json;
    ok(!!r && r.ok === false && r.error === 'CODIGO_INVALIDO' && canjes('komo') === 1 && canjes('pirata') === 0, 'R1 K sigue siendo KOMO (la fábrica manda)', r);

    // ---------- R2 ----------
    const antes = canjes(); const regAntes = consultasRegistro();
    r = (await pedir(A.base, '/vincular', { headers: A.H, body: { codigo: 'Z2345ABCD' } })).json;
    ok(!!r && r.ok === false && r.error === 'CODIGO_RESERVADO' && /«Z»/.test(r.mensaje) && canjes() === antes, 'R2 letra Z desconocida: CODIGO_RESERVADO, sin canje', r);
    ok(consultasRegistro() - regAntes <= 1, 'R2 preguntó al servidor como mucho una vez');
    A.hijo.kill(); await espera(300);

    // ---------- R3 ----------
    mock.ponerRegistro(null);
    const B = await arrancar('b');
    await hasta(async () => (await pedir(B.base, '/estado', { headers: B.H })).json, 10000);
    const antesB = canjes();
    r = (await pedir(B.base, '/vincular', { headers: B.H, body: { codigo: 'W2345ABCD' } })).json;
    ok(!!r && r.ok === false && r.error === 'CODIGO_RESERVADO' && canjes() === antesB, 'R3 backend sin levoprint_registro: W no se conoce (CODIGO_RESERVADO, sin culpar a la red)', r);
    const pagB = (await pedir(B.base, '/', { headers: B.H })).texto;
    ok(/KOMO, KIPU y KUTI/.test(pagB) && !/KAWA/.test(pagB), 'R3 la ventana muestra solo las de fábrica');
    B.hijo.kill(); await espera(300);

    // ---------- R4 ----------
    mock.ponerRegistro('error');
    const C = await arrancar('c');
    await hasta(async () => (await pedir(C.base, '/estado', { headers: C.H })).json, 10000);
    await espera(500);
    r = (await pedir(C.base, '/vincular', { headers: C.H, body: { codigo: 'W2345ABCD' } })).json;
    ok(!!r && r.ok === false && r.error === 'RED' && /revisa tu internet/i.test(r.mensaje) && canjes() === antesB, 'R4 sin poder leer el registro: «revisa tu internet», sin canje', r);
    C.hijo.kill(); await espera(300);

    // ---------- R5 ----------
    mock.ponerRegistro(null);
    const D = await arrancar('d', { registroGuardado: JSON.stringify(guardado) });
    await hasta(async () => (await pedir(D.base, '/estado', { headers: D.H })).json, 10000);
    r = (await pedir(D.base, '/vincular', { headers: D.H, body: { codigo: 'W3456BCDE' } })).json;
    ok(!!r && r.ok === true && r.prefijo === 'kawa' && canjes('kawa') === 2, 'R5 sin registro en el servidor pero con levoprint_apps.json: W sigue vinculando con KAWA', r);
    if (fallas) for (const h of [A, B, C, D]) console.log('\n--- log ' + h.dir + ' ---\n' + h.log.join('').slice(-2500));
  } catch (e) {
    console.error('FALLA inesperada: ' + (e && e.stack || e));
    fallas++;
  } finally {
    for (const h of hijos) { try { h.kill(); } catch { /* ya cerró */ } }
    if (mock) await mock.close();
    await espera(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows puede tener el log abierto un instante */ }
  }
  console.log(fallas ? '\nregistro de apps del agente: ' + fallas + ' FALLA(S)' : '\nregistro de apps del agente: todo OK');
  process.exit(fallas ? 1 : 0);
})();
