// ============================================================
// LevoPrint · Agente de impresión v1.8 (F2: servidor LAN :9120 + USB por la cola de Windows + diario anti-duplicado)  ⚡ <Levodev.app />
// Corre en la PC del local. Poll cada 2s a komo_print_tomar,
// renderiza ESC/POS y lo manda a la IP:puerto de cada estación.
// Se empaqueta a LevoPrint.exe (Node SEA). El dueño solo edita
// "levoprint.txt" (junto al .exe) con 3 datos:
//   LEVO_URL=https://<ref>.supabase.co
//   LEVO_ANON=<anon key>
//   LEVO_DEVICE=<token uuid del dispositivo AGENTE>
//   LEVO_MODO=consola   (opcional: imprime a consola, sin impresora)
// Sin dependencias: Node >= 18 (fetch + net nativos).
//
// [F2 offline] (PLAN_OFFLINE_E_IMPRESION §4 y §6 F2):
//   · Servidor LAN en :9120 (lib/servidorLan): la caja/el mozo mandan el papel
//     DIRECTO por la red del local, sin internet. Solo IP privada, equipos
//     emparejados con PIN (lib/emparejar) y CORS solo *.levodev.app.
//   · USB en Windows por la cola de impresion, RAW (lib/usbwin).
//   · Diario de trabajos (lib/diario): el mismo jobId nunca sale dos veces,
//     venga por la LAN o, al volver internet, desde la nube.
//   · Una cola por impresora con tope de tiempo (lib/colas): una atascada ya
//     no frena a las demas.
//   · Asistente "Buscar impresoras" (lib/buscar): USB, red (:9100 + mDNS), BT.
//   · Latido <p>_agente_lan: publica la IP LAN del agente y reporta lo impreso
//     por la LAN (si la RPC no existe aun, se ignora: compatible hacia atras).
//   · Estaciones guardadas en disco: arranca e imprime por la LAN sin internet.
// Opcionales en levoprint.txt: LEVO_LAN=0 (nunca abre el servidor LAN),
// LEVO_LAN=1 (lo deja siempre abierto; por defecto solo se abre al
// "Activar impresion sin internet" = hay un PIN vigente o equipos emparejados),
// LEVO_PUERTO_LAN=9120, LEVO_ORIGENES=http://localhost:5173 (desarrollo),
// LEVO_DIR=<carpeta de datos> (pruebas).
// El .exe se arma con empaquetar.mjs (un solo archivo para Node SEA).
// ============================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { renderPara } = require('./lib/render');
const { Diario, claveDeNube, jobIdDeNube, jobIdValido } = require('./lib/diario');
const usbwin = require('./lib/usbwin');
const { Colas } = require('./lib/colas');
const { Motor } = require('./lib/motor');
const { Emparejador } = require('./lib/emparejar');
const { crearServidorLan } = require('./lib/servidorLan');
const { buscarTodo } = require('./lib/buscar');
const transportes = require('./lib/transportes');
const red = require('./lib/red');

// --- ¿corro como .exe (SEA) o como `node index.js`? ---
// Empaquetado como Single Executable App, `__dirname` no apunta a una
// carpeta real: la config debe leerse JUNTO AL .exe (dirname del propio
// ejecutable). En desarrollo (`node index.js`) sí vale `__dirname`.
let esExe = false;
try { esExe = require('node:sea').isSea(); } catch { esExe = false; }
// [F2] LEVO_DIR: carpeta de datos aparte (pruebas automaticas: config,
// diario y log fuera del repo).
const BASE_DIR = process.env.LEVO_DIR ? path.resolve(process.env.LEVO_DIR)
                       : esExe ? path.dirname(process.execPath)
                       : (typeof __dirname === 'string' ? __dirname : process.cwd());

// --- log a archivo (para soporte remoto) ---
// Todo lo que sale por pantalla se guarda tambien en levoprint.log,
// junto al programa, para que si la ventana se cierra igual quede el
// rastro y el dueño pueda mandarnos el archivo. Se recorta si crece.
const LOG_FILE = path.join(BASE_DIR, 'levoprint.log');
try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1000000) fs.writeFileSync(LOG_FILE, ''); } catch { /* nada */ }
function alArchivo(nivel, args) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${nivel} ${args.map(String).join(' ')}\n`); } catch { /* disco lleno / solo lectura */ }
}
const _log = console.log.bind(console), _err = console.error.bind(console);
console.log = (...a) => { _log(...a); alArchivo('INFO', a); };
console.error = (...a) => { _err(...a); alArchivo('ERR ', a); };

// --- config: se lee de un archivo de texto junto al programa + entorno ---
// El dueño solo edita "levoprint.txt" con el Bloc de notas. Se aceptan
// tambien .env (compatibilidad) y variables de entorno.
(function cargarConfig() {
  const candidatos = ['levoprint.txt', 'levoprint.config.txt', '.env'];
  for (const nombre of candidatos) {
    const f = path.join(BASE_DIR, nombre);
    if (!fs.existsSync(f)) continue;
    // [canje-v3] El .txt viene del Bloc de notas: CRLF y a veces BOM UTF-8
    // al inicio (que pegaria al primer nombre de clave). Se limpian ambos.
    const crudo = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    for (const linea of crudo.split(/\r\n|\r|\n/)) {
      if (/^\s*(#|$)/.test(linea)) continue;              // comentarios y vacias
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
})();

const URL_BASE = process.env.LEVO_URL || process.env.KOMO_URL;
const ANON = process.env.LEVO_ANON || process.env.KOMO_ANON;
let DEVICE = process.env.LEVO_DEVICE || process.env.KOMO_DEVICE;   // let: el canje del codigo lo completa
// let: el canje lo fija segun la letra del codigo (K=komo, P=kipu) y lo
// guarda en levoprint.txt junto con el device.
let PREFIJO = (process.env.LEVO_PREFIJO || 'komo').trim();
// [canje-v4] Codigo de estacion rev 4: <letra de la app> + 8 del alfabeto sin
// ambiguos. La letra dice a que proyecto llamar (no se prueba a ciegas: cada
// CODIGO_INVALIDO suma al freno por IP). T = KUTI.
const CODIGO_FORMATO = /^[KPT][ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const PREFIJO_POR_LETRA = { K: 'komo', P: 'kipu', T: 'kuti' };
const NOMBRE_APP = { K: 'KOMO', P: 'KIPU', T: 'KUTI' };
// [emparejar] Si el "levoprint.txt" trae LEVO_CODIGO (lo pone el boton
// "Descargar" de la consola) y AUN no hay device, se canjea una vez: el
// agente pide su token al servidor y lo guarda. Asi el dueno no pega el
// token a mano — solo instala. url/anon (publicos) vienen en el txt.
// let: se consume (vacia) tras el primer canje para no reintentarlo luego.
// Normalizado como el servidor: sin espacios ni \r\n, en mayusculas.
let CODIGO = normalizarCodigo(process.env.LEVO_CODIGO);
const MODO_CONSOLA = ((process.env.LEVO_MODO || process.env.KOMO_MODO) || '') === 'consola';
const INTERVALO_MS = 2000;      // con trabajo reciente: la comanda sale al toque
const INTERVALO_MAX_MS = 6000;  // sin trabajo: se espacia de a poco hasta 6 s
const CONFIG_CADA_MS = 60000;   // estaciones/impresoras: cada minuto
let ANCHO = parseInt(process.env.LEVO_ANCHO || '48', 10) || 48; // columnas típicas de térmica 58mm (48) u 80mm (64/72)
// [ventana] LEVO_SINVENTANA=1 (o corriendo como servicio de Windows): no abrir
// navegador, pero la mini-GUI web se sigue sirviendo igual (soporte remoto).
const SIN_VENTANA = /^(1|true|si|s[ií])$/i.test(String(process.env.LEVO_SINVENTANA || ''));
const PUERTO_GUI_BASE = parseInt(process.env.LEVO_PUERTO_GUI || '9110', 10) || 9110;
// [F2] Servidor LAN (ver cabecera). VERSION la ve la app en /v1/hola.
const VERSION = '1.8.0';
// [QA F2 MEDIO-3] El puerto 9120 NO se abre por defecto: solo cuando el
// dueno activa la impresion sin internet (genera un PIN en la ventana) o ya
// hay equipos emparejados. Sin uso, el agente no expone nada en la red.
const LAN_MODO = /^(0|false|no)$/i.test(String(process.env.LEVO_LAN || '')) ? 'apagado'
  : /^(1|true|si|s[ií])$/i.test(String(process.env.LEVO_LAN || '')) ? 'siempre' : 'demanda';
const LAN_ACTIVO = LAN_MODO !== 'apagado';
// Ritmo del latido LAN (pruebas automaticas lo bajan; en el local, 60 s).
const LATIDO_MS = parseInt(process.env.LEVO_LATIDO_MS || '60000', 10) || 60000;
const PUERTO_LAN = parseInt(process.env.LEVO_PUERTO_LAN || '9120', 10) || 9120;
const ORIGENES_EXTRA = red.leerOrigenesExtra(process.env.LEVO_ORIGENES);

// Plantilla que se crea sola la primera vez, para que el dueño solo
// tenga que pegar sus 3 datos y volver a abrir el programa.
const PLANTILLA = [
  '# ====== LevoPrint · Agente de impresion ======',
  '# Pega aqui los 3 datos que te dio LevoDev y guarda (Ctrl+S).',
  '# Luego cierra y vuelve a abrir LevoPrint.exe.',
  '',
  'LEVO_URL=https://TU-PROYECTO.supabase.co',
  'LEVO_ANON=PEGA-AQUI-LA-CLAVE-ANON',
  'LEVO_DEVICE=PEGA-AQUI-EL-TOKEN-DEL-AGENTE',
  'LEVO_PREFIJO=komo',
  '',
  '# Opcional: para probar sin impresora, quita el # de la linea de abajo.',
  '# LEVO_MODO=consola',
  ''
].join('\r\n');

function pausarYSalir(codigo) {
  // En el .exe (doble clic) la ventana se cerraria de golpe y el dueño
  // no alcanzaria a leer. Dejamos el mensaje en pantalla.
  if (esExe) {
    try {
      process.stdout.write('\nPresiona ENTER para cerrar...');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    } catch { /* sin consola interactiva: igual salimos */ }
  }
  process.exit(codigo);
}

function faltaConfig() {
  return !URL_BASE || !ANON || !DEVICE || /TU-PROYECTO|PEGA-AQUI/.test(String(URL_BASE) + ANON + DEVICE);
}
// Solo URL/ANON (sin exigir DEVICE): si estos dos estan bien, la mini-GUI
// puede quedarse sirviendo la pagina para que el dueño vincule por codigo
// SIN reiniciar el programa ni tocar el .txt a mano.
function faltaUrlAnon() {
  return !URL_BASE || !ANON || /TU-PROYECTO|PEGA-AQUI/.test(String(URL_BASE) + ANON);
}
function abortarSinConfig() {
  const ruta = path.join(BASE_DIR, 'levoprint.txt');
  let creada = false;
  try {
    if (!fs.existsSync(ruta)) { fs.writeFileSync(ruta, PLANTILLA, 'utf8'); creada = true; }
  } catch { /* carpeta de solo lectura: se explica igual */ }
  console.error('\n=============================================');
  console.error(' LevoPrint · Agente de impresion — FALTA CONFIGURAR');
  console.error('=============================================');
  if (creada) {
    console.error('Se acaba de crear el archivo:');
    console.error('   ' + ruta);
    console.error('Abrelo con el Bloc de notas, pega tus 3 datos');
    console.error('(KOMO_URL, KOMO_ANON, KOMO_DEVICE), guarda y vuelve a abrir el programa.');
  } else {
    console.error('Edita el archivo "levoprint.txt" que esta junto a este programa');
    console.error('y completa KOMO_URL, KOMO_ANON y KOMO_DEVICE (te los da LevoDev).');
  }
  console.error('=============================================\n');
  pausarYSalir(1);
}

function normalizarCodigo(c) {
  return String(c || '').replace(/[\s\uFEFF]+/g, '').toUpperCase();
}

// [canje-v3] Error HTTP con el "message" de Postgres en e.pg. Las RPC del
// agente pasan por __SCHEMA__._agente(device), que hace raise
// 'AGENTE_INVALIDO' si el token no existe o el dispositivo esta inactivo
// (p. ej. lo REEMPLAZO otro equipo al conectarse). PostgREST responde
// HTTP 400 {"message":"AGENTE_INVALIDO"}.
async function rpc(fn, p) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    signal: AbortSignal.timeout(12000),
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p }),
  });
  if (!r.ok) {
    const txt = await r.text();
    const e = new Error(`${fn} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    try { e.pg = String((JSON.parse(txt) || {}).message || '').trim(); } catch { e.pg = ''; }
    throw e;
  }
  return r.json();
}
const esAgenteInvalido = (e) => !!(e && e.pg === 'AGENTE_INVALIDO');

// --- ESC/POS ---
// [F2] El render vive en lib/render.js (copia literal, probada byte a byte
// contra los dorados del index.js original). Aqui solo se elige el ancho.
function render(job) { return renderPara(ANCHO).render(job); }

// Render SERVIDOR: el ticket se arma en la edge function `<prefijo>-print`
// y aquí solo se imprime. Así los cambios de formato/firma se despliegan
// sin re-instalar el agente. Si el endpoint falla, cae al render local.
// [qa5] pfx = prefijo capturado por la vuelta del ciclo (igual que las RPC).
async function renderRemoto(job, pfx, topeMs) {
  const r = await fetch(`${URL_BASE}/functions/v1/${pfx || PREFIJO}-print`, {
    signal: AbortSignal.timeout(topeMs || 8000),
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: job.tipo, payload: job.payload, ancho: ANCHO }),
  });
  if (!r.ok) throw new Error('render remoto HTTP ' + r.status);
  const j = await r.json();
  if (!j || j.ok !== true || !j.esc) throw new Error('render remoto sin esc');
  return Buffer.from(j.esc, 'base64').toString('binary');
}

// --- [F2] motor comun nube/LAN: diario, colas por impresora, estaciones en disco ---
const diario = new Diario(path.join(BASE_DIR, 'levoprint-diario.jsonl'));
const colas = new Colas({ timeoutMs: 25000 });
const motor = new Motor({
  diario, colas, renderPara, getAncho: () => ANCHO, modoConsola: MODO_CONSOLA,
  log: (...a) => console.log(...a), logErr: (...a) => console.error(...a),
  archivoEstaciones: path.join(BASE_DIR, 'levoprint-estaciones.json'),
  archivoAsignaciones: path.join(BASE_DIR, 'levoprint-asignaciones.json'),
});
const emparejador = new Emparejador(path.join(BASE_DIR, 'levoprint-equipos.json'));

// Estado de la NUBE visto por el ciclo (para /v1/estado y el render de la LAN).
const nube = { okTs: 0, falloTs: 0, fallos: 0, lanSoportado: null, lanReintentoTs: 0, ultimoLatidoLan: 0 };

// --- ciclo principal ---
let cicloConfig = 0;            // ms de la última lectura de config
let espera = INTERVALO_MS;
// [qa4] Control del ciclo: un solo bucle vivo. cicloEnCurso = hay una vuelta
// ejecutandose; cicloTimer = la proxima vuelta programada. despertarCiclo()
// adelanta la proxima vuelta sin crear un segundo bucle.
let cicloEnCurso = false;
let cicloTimer = null;
// [qa4] Desactivado desde la consola (AGENTE_INVALIDO): se CONSERVA el token
// y se reintenta. Si el dueno lo reactiva, la siguiente vuelta responde bien
// y retoma solo; si vincula un codigo nuevo, el token se cambia recien
// cuando ese canje sale bien.
// [qa5] Backoff para el "equipo olvidado": 45 s la primera hora, luego cada
// 5 min y, pasadas 24 h, cada 15 min. Abrir la ventana o vincular un codigo
// despierta el ciclo al instante.
const HORA_MS = 3600000;
function esperaDesactivado(desdeTs) {
  const t = Date.now() - desdeTs;
  if (t < HORA_MS) return 45000;
  if (t < 24 * HORA_MS) return 5 * 60000;
  return 15 * 60000;
}
// Texto visible: el aviso base y, si ya paso al menos una hora, cuanto lleva.
function textoDesactivado(d) {
  if (!d) return null;
  const horas = Math.floor((Date.now() - d.desde) / HORA_MS);
  return msgDesactivado(d.prefijo) + (horas >= 1
    ? ` Lleva ${horas} ${horas === 1 ? 'hora' : 'horas'} desactivado; si ya no se usa, puedes cerrar LevoPrint.`
    : '');
}
let ultimoDespertarGui = 0;

// [gui] Estado en vivo que consume la mini-GUI web (GET /estado). Nada de
// esto altera el ciclo de impresion: solo se lee/escribe para informar.
const guiEstado = {
  imprimiendo: false,       // true mientras se procesa un job ahora mismo
  ultimoError: null,        // { mensaje, ts } del ultimo job o ciclo fallido
  ultimoOk: null,           // ts del ultimo job impreso ok
  ultimaSync: null,         // ts de la ultima vez que refrescarConfig() respondio
  desactivado: null,        // [qa4] { mensaje, ts } mientras el servidor responda AGENTE_INVALIDO
};

async function refrescarConfig(dev, pfx) {
  const cfg = await rpc(`${pfx}_agente_config`, { device: dev });
  motor.ponerEstaciones(cfg.estaciones || [], pfx);
  guiEstado.ultimaSync = Date.now();
  console.log(`[cfg] ${motor.estaciones.size} estaciones:`,
    motor.listaEstaciones().map((e) => `${e.nombre}@${e.via}`).join(' · '));
}

// [F2] Latido LAN: publica la IP del agente en la red del local (la app la
// usa para imprimir sin internet), trae transporte/destino de cada estacion
// (columnas nuevas, plantilla impresion_local) y reporta los jobId impresos
// por la LAN para que la nube no los vuelva a encolar. Si la RPC no existe
// todavia en la base, se reintenta cada 10 min sin ensuciar el log.
function rpcNoExiste(e) {
  return !!e && (/HTTP 404/.test(e.message) || /PGRST202|Could not find the function/i.test(e.message));
}
// [QA F2 ALTO-1] Asignaciones hechas en esta PC que la nube aun no conoce:
// se reintenta avisarlas. Al confirmarse se BORRA la local (desde ahi manda
// la nube, y si el dueno la cambia en la app, se respeta).
async function avisarAsignacion(dev, pfx, estacion, a) {
  try {
    // antes = lo que tenia la nube al asignar: si la nube cambio despues, el
    // servidor responde CAMBIO_EN_NUBE y NO pisa el cambio del dueno [re-QA F2].
    const r = await rpc(`${pfx}_agente_asignar`, { device: dev, estacion, transporte: a.transporte, destino: a.destino, antes: a.nubeAntes || null });
    if (r && r.ok === false && r.error === 'CAMBIO_EN_NUBE') { motor.descartarPorNube(estacion); return false; }
    if (r && r.ok === false) {
      // La nube la rechaza (estacion borrada, destino invalido): no tiene
      // sentido reintentar; queda solo en esta PC y se avisa en el log.
      console.error(`[asignar] la nube rechazo la asignacion de ${estacion}: ${r.error}`);
      motor.quedarSoloLocal(estacion);
      return false;
    }
    motor.confirmarNube(estacion);
    return true;
  } catch (e) {
    if (rpcNoExiste(e)) { motor.quedarSoloLocal(estacion); return false; }
    return false;   // sin internet: queda pendienteNube y se reintenta en el latido
  }
}

// [re-QA F2] Primero se trae lo que tiene la nube (agente_lan) y DESPUES se
// avisan las asignaciones pendientes: si el dueno cambio la impresora en la
// app mientras tanto, ponerTransportes descarta la local antes de reintentar.
async function latidoLan(dev, pfx) {
  try { await latidoLanNube(dev, pfx); }
  finally { for (const a of motor.pendientesNube()) await avisarAsignacion(dev, pfx, a.estacion, a); }
}

async function latidoLanNube(dev, pfx) {
  if (nube.lanSoportado === false && Date.now() < nube.lanReintentoTs) return;
  const impresos = diario.sinReportar(200);
  try {
    const r = await rpc(`${pfx}_agente_lan`, {
      device: dev, version: VERSION,
      lan: lanEstado.escuchando ? { ips: red.ipsLocales().map((x) => x.ip), puerto: PUERTO_LAN } : null,
      impresos: impresos.map((x) => ({ clave: x.clave, estacion: x.estacion, ts: x.ts })),
    });
    nube.lanSoportado = true;
    nube.ultimoLatidoLan = Date.now();
    if (r && Array.isArray(r.estaciones)) motor.ponerTransportes(r.estaciones);
    if (impresos.length) diario.marcarReportados(impresos.map((x) => x.k));
  } catch (e) {
    if (rpcNoExiste(e)) {
      if (nube.lanSoportado !== false) console.log('[lan] la base aun no tiene ' + pfx + '_agente_lan (plantilla impresion_local): imprimo igual.');
      nube.lanSoportado = false;
      nube.lanReintentoTs = Date.now() + 10 * 60000;
      nube.ultimoLatidoLan = Date.now();
    } else throw e;
  }
}

// Render remoto con tope corto para la LAN: solo si la nube contesto hace
// poco (sin internet, el render local sale al toque en vez de esperar 8 s).
async function renderParaLan(job, pfx) {
  if (Date.now() - nube.okTs > 30000) return null;
  return renderRemoto(job, pfx, 2500);
}

async function ciclo() {
  cicloTimer = null;
  cicloEnCurso = true;
  // Token de ESTA vuelta: si a media vuelta se canjea un codigo nuevo, los
  // trabajos ya tomados se marcan con el token que los tomo, y un
  // AGENTE_INVALIDO del token viejo no pisa el estado del nuevo.
  const dev = DEVICE;
  const pfx = PREFIJO;
  try {
    if (Date.now() - cicloConfig >= CONFIG_CADA_MS) { await refrescarConfig(dev, pfx); cicloConfig = Date.now(); }
    const r = await rpc(`${pfx}_print_tomar`, { device: dev, limite: 10 });
    if (nube.fallos) console.log(`[ciclo] la nube volvio tras ${nube.fallos} intentos fallidos.`);
    nube.okTs = Date.now(); nube.fallos = 0;
    if (guiEstado.desactivado && dev === DEVICE) {
      console.log('[agente] el servidor volvio a aceptar este equipo: retomo la impresion.');
      guiEstado.desactivado = null;
    }
    // Espera progresiva: con trabajos vuelve a 2 s; vacío, suma 1 s hasta 6 s.
    // (Antes 2 s fijos, las 24 h: 43 mil consultas al día por local.)
    espera = (r.jobs && r.jobs.length) ? INTERVALO_MS : Math.min(INTERVALO_MAX_MS, espera + 1000);
    // [F2] Cada trabajo pasa por el motor (diario + cola de SU impresora): los
    // de impresoras distintas salen a la vez; los de la misma, en orden. Un
    // jobId que ya salio por la LAN se marca IMPRESO sin otro papel.
    const jobs = r.jobs || [];
    if (jobs.length) guiEstado.imprimiendo = true;
    try {
      await Promise.all(jobs.map(async (job) => {
        const clave = claveDeNube(job);
        const res = await motor.procesar({
          jobId: jobIdDeNube(job), origen: 'NUBE', estacion: job.estacion, tipo: job.tipo, payload: job.payload,
          // Render en el SERVIDOR (formato siempre al día); respaldo local si cae.
          renderTexto: (jb) => renderRemoto({ ...job, payload: jb.payload }, pfx),
        });
        if (res.duplicado) console.log(`[dedupe] job ${job.id} (${clave}) ya habia salido: se marca impreso sin otro papel.`);
        if (res.ok) guiEstado.ultimoOk = Date.now();
        else guiEstado.ultimoError = { mensaje: res.error, ts: Date.now() };
        // Si marcar falla (internet se fue justo ahora), el diario evita la
        // reimpresion cuando la nube lo vuelva a entregar tras la reserva.
        await rpc(`${pfx}_print_marcar`, res.ok ? { device: dev, id: job.id, ok: true }
          : { device: dev, id: job.id, ok: false, error: res.errorInterno || res.error });
      }));
    } finally {
      guiEstado.imprimiendo = false;
    }
    // Latido LAN: cada minuto, o cada 15 s mientras haya impresos por reportar
    // o asignaciones de esta PC sin avisar a la nube.
    const urgente = diario.sinReportar(1).length || motor.pendientesNube().length;
    if (Date.now() - nube.ultimoLatidoLan >= (urgente ? Math.min(15000, LATIDO_MS) : LATIDO_MS)) {
      try { await latidoLan(dev, pfx); } catch (e) { console.error('[lan] latido:', e.message); }
    }
  } catch (e) {
    if (esAgenteInvalido(e)) {
      // [qa4] Desactivado o reemplazado en la consola. NO se olvida el token
      // (el dueno puede reactivarlo): se pausa y se reintenta cada 45 s. La
      // mini-GUI muestra el aviso y acepta un codigo nuevo.
      if (dev === DEVICE) {
        if (!guiEstado.desactivado) {
          console.error('[agente] ' + msgDesactivado(pfx));
          guiEstado.desactivado = { prefijo: pfx, desde: Date.now(), ts: Date.now() };
        }
        guiEstado.desactivado.ts = Date.now(); // ultimo intento
        espera = esperaDesactivado(guiEstado.desactivado.desde);
        cicloConfig = 0; // al volver, lo primero es releer estaciones
      }
    } else {
      // [F2] Sin internet: un solo aviso por racha y espera creciente hasta
      // 15 s (la LAN sigue imprimiendo aparte). Antes: un error cada 2 s.
      nube.fallos += 1; nube.falloTs = Date.now();
      if (nube.fallos === 1 || nube.fallos % 30 === 0) console.error('[ciclo]', e.message, nube.fallos > 1 ? `(${nube.fallos} intentos)` : '');
      guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
      espera = Math.min(15000, Math.max(INTERVALO_MS, espera + 2000));
    }
  } finally {
    cicloEnCurso = false;
    if (DEVICE) cicloTimer = setTimeout(ciclo, espera);
  }
}

// Adelanta la proxima vuelta (tras un canje). Si hay una vuelta en curso, su
// finally ya programa la siguiente con la espera corta.
function despertarCiclo() {
  cicloConfig = 0;
  espera = INTERVALO_MS;
  if (cicloEnCurso) return;
  if (cicloTimer) { clearTimeout(cicloTimer); cicloTimer = null; }
  ciclo();
}

// [qa4] Edita levoprint.txt sin romper el BOM: el Bloc de notas puede dejar
// un BOM UTF-8 al inicio y, si LEVO_DEVICE esta en la PRIMERA linea, el
// regex ^LEVO_DEVICE no la veia (y se agregaba un segundo LEVO_DEVICE que al
// releer perdia contra el primero). Se quita el BOM, se edita y se repone.
function editarTxt(fn) {
  const ruta = path.join(BASE_DIR, 'levoprint.txt');
  const crudo = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
  const bom = crudo.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  const txt = bom ? crudo.slice(1) : crudo;
  const nuevo = fn(txt);
  if (nuevo !== txt) fs.writeFileSync(ruta, bom + nuevo, 'utf8');
}
// Reemplaza CLAVE=... (primera aparicion) o la agrega al final.
function ponerClave(txt, clave, valor) {
  const re = new RegExp('^[ \\t]*' + clave + '[ \\t]*=.*$', 'im');
  if (re.test(txt)) return txt.replace(re, clave + '=' + valor);
  return txt + (txt.endsWith('\n') || txt === '' ? '' : '\r\n') + clave + '=' + valor + '\r\n';
}

// [qa4] Nombre de la pantalla de la consola segun la app. Rev 5: toda
// respuesta de canjear trae "seccion" (KOMO "Estaciones", KIPU "Impresoras");
// manda esa, y si no viene (o el mensaje no sale de un canje) se usa la
// ultima vista para ese prefijo en esta sesion o, si no, la conocida.
const APP_POR_PREFIJO = { komo: 'KOMO', kipu: 'KIPU', kuti: 'KUTI' };
const SECCION_POR_PREFIJO = { komo: 'Estaciones', kipu: 'Impresoras', kuti: 'Impresoras' };
const seccionVista = {}; // prefijo -> seccion que devolvio el servidor
function consolaDe(prefijo, seccion) {
  const pfx = String(prefijo || '').toLowerCase();
  const app = APP_POR_PREFIJO[pfx] || pfx.toUpperCase();
  const sec = String(seccion || seccionVista[pfx] || SECCION_POR_PREFIJO[pfx] || '').trim();
  if (app && sec) return 'tu consola de ' + app + ' › ' + sec;
  if (app) return 'tu consola de ' + app;
  return 'tu consola';
}
function msgDesactivado(prefijo) {
  return 'Este equipo está desactivado desde la consola; si lo reactivan vuelve a imprimir solo. '
       + 'Para vincularlo de nuevo, ingresa un código nuevo de ' + consolaDe(prefijo) + '.';
}

// [emparejar] Canjea un codigo (el de LEVO_CODIGO al arrancar, o el que el
// dueno pega en la mini-GUI): pide el token del agente al servidor (canjear
// es de un uso) y lo persiste en levoprint.txt, para que la proxima vez que
// abra el programa ya arranque solo. Devuelve {ok,...} para poder responder
// tanto en consola como en el endpoint POST /vincular.
// [canje-v3] Mensajes para el dueno (no tecnico), mismo mapa que la app
// Android (Emparejamiento.mensajeError). "segundos" solo en DEMASIADOS_INTENTOS;
// "app" (la letra) en OTRA_APP y CODIGO_RESERVADO; "prefijo" elige el nombre
// de la app y "seccion" (rev 5) el de la pantalla de la consola (consolaDe).
function mensajeCanje(err, segundos, app, prefijo, seccion) {
  const consola = consolaDe(prefijo, seccion);
  const seg = parseInt(segundos, 10) || 0;
  const nomApp = NOMBRE_APP[String(app || '').toUpperCase()] || String(app || '').toUpperCase() || 'otra app';
  const txtEspera = seg > 0 ? `Espera ${seg} ${seg === 1 ? 'segundo' : 'segundos'} y vuelve a intentar.`
                            : 'Espera un momento y vuelve a intentar.';
  return ({
    CODIGO_INVALIDO: 'El código no es válido. Revisa que esté bien escrito.',
    CODIGO_VENCIDO: 'El código venció (dura 15 min). Genera uno nuevo en ' + consola + '.',
    CODIGO_USADO: 'Ese código ya se usó. Genera uno nuevo en ' + consola + '.',
    DEMASIADOS_INTENTOS: 'Hubo demasiados intentos con códigos equivocados. ' + txtEspera,
    OTRA_APP: 'Este código es de ' + nomApp + '. Genera el código en la consola de la app donde quieres imprimir.',
    AGENTE_YA_VINCULADO: 'Otro equipo se vinculó a este local mientras tanto. Genera un código nuevo en ' + consola + '.',
    IP_DESCONOCIDA: 'No se pudo identificar la conexión. Intenta de nuevo.',
    AGENTE_INVALIDO: msgDesactivado(prefijo),
    CODIGO_FORMATO: 'El código tiene 9 caracteres y empieza con K (KOMO), P (KIPU) o T (KUTI). Revisa que esté bien escrito.',
    CODIGO_RESERVADO: 'Este código es de ' + nomApp + ', que esta versión de LevoPrint todavía no admite. Actualiza LevoPrint e intenta de nuevo.',
    SIN_CODIGO: 'Escribe el código de 9 caracteres.',
  })[err] || ('No se pudo vincular (' + err + ').');
}

async function canjearCodigo(codigoIn) {
  const cod = normalizarCodigo(codigoIn || CODIGO);
  if (!cod) return { ok: false, error: 'SIN_CODIGO', mensaje: mensajeCanje('SIN_CODIGO') };
  // Con token vigente no se canjea; si esta DESACTIVADO, si (el token viejo
  // se reemplaza solo si este canje sale bien).
  if (DEVICE && !guiEstado.desactivado) return { ok: false, error: 'YA_VINCULADO', mensaje: 'Este agente ya está vinculado.' };
  if (!URL_BASE || !ANON) return { ok: false, error: 'FALTA_URL_ANON', mensaje: 'Falta LEVO_URL/LEVO_ANON en levoprint.txt.' };
  if (!codigoIn) CODIGO = ''; // el del .txt se intenta UNA vez por sesion (el canje es de un uso)
  // Formato y letra se revisan aqui: un codigo mal escrito no gasta un
  // intento del freno del servidor.
  if (!CODIGO_FORMATO.test(cod)) {
    const msg = mensajeCanje('CODIGO_FORMATO');
    console.error(msg);
    return { ok: false, error: 'CODIGO_FORMATO', mensaje: msg };
  }
  const letra = cod.charAt(0);
  const prefijoCod = PREFIJO_POR_LETRA[letra];
  if (!prefijoCod) {
    const msg = mensajeCanje('CODIGO_RESERVADO', 0, letra);
    console.error(msg);
    return { ok: false, error: 'CODIGO_RESERVADO', mensaje: msg };
  }
  console.log('Emparejando con el codigo ' + cod + ' (' + prefijoCod + ')...');
  let d;
  try {
    d = await rpc(`${prefijoCod}_estacion_codigo_canjear`, { codigo: cod });
  } catch (e) {
    console.error('No se pudo emparejar (revisa tu internet): ' + e.message);
    return { ok: false, error: 'RED', mensaje: 'No se pudo emparejar (revisa tu internet): ' + e.message };
  }
  if (d && d.seccion) seccionVista[prefijoCod] = String(d.seccion).trim();
  if (!d || d.ok !== true) {
    const err = (d && d.error) || 'ERROR';
    const msg = mensajeCanje(err, d && d.segundos, d && d.app, prefijoCod, d && d.seccion);
    console.error(msg);
    return { ok: false, error: err, mensaje: msg, segundos: (d && d.segundos) || undefined };
  }
  if (!d.device) {
    const msg = 'El servidor respondió sin los datos necesarios. Intenta de nuevo.';
    console.error(msg);
    return { ok: false, error: 'RESPUESTA_INCOMPLETA', mensaje: msg };
  }
  DEVICE = d.device;
  process.env.LEVO_DEVICE = d.device;
  // El prefijo del bundle manda; si no viene, el de la letra. Se guarda en el
  // .txt para que al reabrir el ciclo llame al proyecto correcto.
  PREFIJO = String(d.prefijo || prefijoCod).trim();
  process.env.LEVO_PREFIJO = PREFIJO;
  if (d.seccion) seccionVista[PREFIJO.toLowerCase()] = String(d.seccion).trim();
  try {
    editarTxt((txt) => {
      txt = txt.replace(/^[ \t]*LEVO_CODIGO[ \t]*=.*$/gim, '# LEVO_CODIGO usado');
      txt = ponerClave(txt, 'LEVO_DEVICE', d.device);
      return ponerClave(txt, 'LEVO_PREFIJO', PREFIJO);
    });
  } catch (_) { /* carpeta de solo lectura: queda en memoria esta sesion */ }
  guiEstado.desactivado = null;
  guiEstado.ultimoError = null;
  // modo/reemplazara (rev 4): el servidor apaga a los anteriores recien con
  // el PRIMER trabajo IMPRESO de este agente; hasta entonces los dos imprimen.
  // (reemplazados = los que ya se apagaron: vale 0 en el canje.)
  const n = parseInt(d.reemplazara, 10) || 0;
  const aviso = (d.modo === 'reemplazar' && n === 1) ? 'Cuando imprimas tu primera comanda, se apagará el equipo anterior.'
    : (d.modo === 'reemplazar' && n > 1) ? `Cuando imprimas tu primera comanda, se apagarán los ${n} equipos anteriores.`
    : d.modo === 'adicional' ? 'Quedó como equipo adicional.' : '';
  console.log('Emparejado como: ' + (d.nombre || 'estacion') + '. Listo.' + (aviso ? ' ' + aviso : '') + (d.reintento ? ' (reintento)' : ''));
  return { ok: true, nombre: d.nombre, modo: d.modo || null, reemplazara: n, reintento: !!d.reintento, aviso };
}

// Persiste LEVO_ANCHO en levoprint.txt (mismo patron que LEVO_DEVICE arriba).
function persistirAncho(valor) {
  try {
    const ruta = path.join(BASE_DIR, 'levoprint.txt');
    editarTxt((txt) => ponerClave(txt, 'LEVO_ANCHO', valor));
    return true;
  } catch (_) { return false; /* carpeta de solo lectura: queda en memoria esta sesion */ }
}

// ============================================================
// [gui] Mini-GUI web local. Node no tiene ventana nativa: en vez de eso
// el agente sirve una paginita en http://127.0.0.1:9110 y (si hay entorno
// grafico) abre el navegador ahi. NO reemplaza la consola/log: es un
// complemento visual. Si el puerto esta ocupado, prueba los siguientes.
// ============================================================
function leerBodyJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function responderJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function estadoActual() {
  const vinculado = !faltaConfig();
  const sinUrlAnon = faltaUrlAnon();
  // [F2] ruta efectiva de cada estacion (asignacion local > nube > ip vieja).
  const listaEst = motor.listaEstaciones().map((e) => ({
    id: e.id, nombre: e.nombre, ip: e.ip, puerto: e.puerto, via: e.via, cola: e.cola,
    local: !!motor.asignaciones[e.id], fuente: e.fuente, pendienteNube: e.pendienteNube,
  }));
  let semaforo = 'sin_vincular';
  if (sinUrlAnon) semaforo = 'sin_configurar';
  else if (!vinculado) semaforo = 'sin_vincular';
  else if (guiEstado.desactivado) semaforo = 'desactivado';
  else if (guiEstado.imprimiendo) semaforo = 'imprimiendo';
  else if (nube.fallos > 0) semaforo = 'sin_internet';
  else if (guiEstado.ultimoError && (!guiEstado.ultimoOk || guiEstado.ultimoError.ts > guiEstado.ultimoOk)) semaforo = 'sin_impresora';
  else semaforo = 'conectado';
  return {
    ok: true,
    version: VERSION,
    modoConsola: MODO_CONSOLA,
    ancho: ANCHO,
    prefijo: PREFIJO,
    sinUrlAnon,
    vinculado,
    semaforo,
    estaciones: listaEst,
    ultimoError: guiEstado.ultimoError,
    ultimoOk: guiEstado.ultimoOk,
    ultimaSync: guiEstado.ultimaSync,
    desactivado: textoDesactivado(guiEstado.desactivado),
    // [F2] Solo esta ventana (127.0.0.1) ve el PIN: es la prueba de que quien
    // empareja tiene acceso fisico a la PC.
    lan: {
      activo: LAN_ACTIVO, modo: LAN_MODO, escuchando: lanEstado.escuchando, error: lanEstado.error,
      urls: red.ipsLocales().map((x) => `http://${x.ip}:${PUERTO_LAN}`),
      pin: (emparejador.pinVigente() || {}).valor || null,
      pinVence: (emparejador.pinVigente() || {}).expira || null,
      equipos: emparejador.lista(),
      nubeConoce: nube.lanSoportado,
    },
  };
}

// ============================================================
// [F2] Servidor LAN :9120 — manejadores (contrato en lib/servidorLan.js)
// ============================================================
const lanEstado = { escuchando: false, error: null, servidor: null };
let cacheBusqueda = null;   // { ts, promesa } (buscar es caro: 1 vez cada 10 s)

function buscarImpresoras() {
  if (cacheBusqueda && Date.now() - cacheBusqueda.ts < 10000) return cacheBusqueda.promesa;
  const promesa = buscarTodo({}).catch((e) => ({ ok: false, impresoras: [], avisos: [e.message] }));
  cacheBusqueda = { ts: Date.now(), promesa };
  return promesa;
}

// [QA F2 MEDIO-4] Un solo punto de validacion del destino: lib/transportes.
const validarDestino = transportes.validarDestino;

async function imprimirPrueba(ruta, nombre) {
  const texto = render({ tipo: 'PRUEBA', payload: {} });
  if (MODO_CONSOLA) { console.log('[prueba] ' + texto.replace(/[\x00-\x1f]/g, '').trim()); return { ok: true, aviso: 'Modo consola: se mostro en consola.' }; }
  const cola = ruta.transporte + '|' + ruta.destino;
  await colas.encolar(cola, () => transportes.enviar(ruta, texto, { timeoutMs: 20000 }), 30000);
  guiEstado.ultimoOk = Date.now();
  return { ok: true, aviso: 'Prueba enviada a ' + (nombre || transportes.describir(ruta)) + '.' };
}

const manejadoresLan = {
  async estado(ctx) {
    return {
      ok: true, version: VERSION, prefijo: PREFIJO, ancho: ANCHO, equipo: ctx.equipo.nombre,
      nube: { enLinea: Date.now() - nube.okTs < 30000, okTs: nube.okTs || null },
      // fuente: 'local' (asignada en esta PC) | 'nube'; pendienteNube: aun sin avisar.
      estaciones: motor.listaEstaciones().map((e) => ({ id: e.id, nombre: e.nombre, via: e.via, transporte: e.ruta ? e.ruta.transporte : null, fuente: e.fuente, pendienteNube: e.pendienteNube, cola: e.cola })),
    };
  },
  async diario() { return { ok: true, recientes: diario.recientes(50) }; },
  async impresoras() { return buscarImpresoras(); },
  async refrescar() { if (!faltaConfig()) despertarCiclo(); return { ok: true }; },
  async prueba(b) {
    try {
      if (b && b.estacion) {
        const ruta = motor.ruta(b.estacion);
        if (!ruta) return { ok: false, error: 'SIN_IMPRESORA', mensaje: 'La estacion no tiene impresora asignada.' };
        return await imprimirPrueba(ruta, (motor.estaciones.get(b.estacion) || {}).nombre);
      }
      const err = validarDestino(b && b.transporte, b && b.destino);
      if (err) return { ok: false, error: 'DESTINO_INVALIDO', mensaje: err };
      return await imprimirPrueba({ transporte: b.transporte, destino: String(b.destino) });
    } catch (e) {
      // Nunca el mensaje crudo de la red o de Windows hacia la app (queda en el log).
      console.error('[prueba] ' + e.message);
      return { ok: false, error: 'IMPRESION', mensaje: transportes.mensajePublico(e) };
    }
  },
  async imprimir(b, ctx) {
    if (!b || !jobIdValido(b.jobId)) return { ok: false, status: 400, error: 'JOBID_INVALIDO', mensaje: 'Falta jobId (uuid del equipo).' };
    if (typeof b.tipo !== 'string' || !/^[A-Z_]{3,20}$/.test(b.tipo)) return { ok: false, status: 400, error: 'TIPO_INVALIDO' };
    if (!b.estacion || !motor.estaciones.has(b.estacion)) return { ok: false, status: 404, error: 'ESTACION_DESCONOCIDA', mensaje: 'LevoPrint no conoce esa estacion (abre LevoPrint con internet una vez).' };
    const pfx = PREFIJO;
    const payload = b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload) ? b.payload : {};
    const r = await motor.procesar({
      jobId: b.jobId, origen: 'LAN', estacion: b.estacion, tipo: b.tipo, payload,
      renderTexto: (jb) => renderParaLan(jb, pfx),
    });
    if (r.ok) { guiEstado.ultimoOk = Date.now(); return { ok: true, jobId: b.jobId, via: r.via, duplicado: !!r.duplicado, equipo: ctx.equipo.nombre }; }
    guiEstado.ultimoError = { mensaje: r.error, ts: Date.now() };
    // dudoso: la impresora pudo haberlo sacado; reintentar con el MISMO jobId
    // (si salio, el reintento sale con sello REIMPRESION).
    return { ok: false, status: 502, error: 'IMPRESION', mensaje: r.error, via: r.via, dudoso: !!r.dudoso };
  },
};

// [QA F2 MEDIO-3] Abre o cierra el 9120 segun haga falta (ver LAN_MODO).
function lanHaceFalta() {
  if (LAN_MODO === 'apagado') return false;
  if (LAN_MODO === 'siempre') return true;
  return !!emparejador.pinVigente() || emparejador.lista().length > 0;
}
function asegurarLan() {
  emparejador.purgarVencidos();   // un token vencido no mantiene el puerto abierto
  const falta = lanHaceFalta();
  if (falta && !lanEstado.servidor) iniciarLan();
  else if (!falta && lanEstado.servidor) {
    // close() no corta las conexiones keep-alive abiertas: se cierran a mano.
    try { lanEstado.servidor.close(); lanEstado.servidor.closeAllConnections(); } catch { /* ya cerrado */ }
    lanEstado.servidor = null; lanEstado.escuchando = false;
    console.log('[lan] sin PIN ni equipos emparejados: se cierra el puerto ' + PUERTO_LAN + '.');
  }
}

function iniciarLan() {
  if (!LAN_ACTIVO) { console.log('[lan] servidor de la red desactivado (LEVO_LAN=0).'); return; }
  const servidor = crearServidorLan({
    emparejador, version: VERSION, origenesExtra: ORIGENES_EXTRA,
    bloqueado: () => !!guiEstado.desactivado,
    manejadores: manejadoresLan, log: (...a) => console.log(...a),
  });
  servidor.on('error', (e) => {
    lanEstado.escuchando = false;
    lanEstado.error = e.code === 'EADDRINUSE' ? `el puerto ${PUERTO_LAN} esta ocupado (otro LevoPrint abierto?)` : e.message;
    console.error('[lan] ' + lanEstado.error);
    // Sin escuchar: se suelta para que asegurarLan (cada 30 s) lo reintente.
    if (lanEstado.servidor === servidor) lanEstado.servidor = null;
  });
  servidor.listen(PUERTO_LAN, '0.0.0.0', () => {
    lanEstado.escuchando = true; lanEstado.error = null;
    const urls = red.ipsLocales().map((x) => `http://${x.ip}:${PUERTO_LAN}`);
    console.log('[lan] impresion por la red del local en ' + (urls.join(' · ') || ('puerto ' + PUERTO_LAN)));
  });
  lanEstado.servidor = servidor;
}

function paginaHtml() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LevoPrint · Agente</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, Segoe UI, Arial, sans-serif; background:#0f1115; color:#e8e8ea; padding:24px; }
  .card { max-width:560px; margin:0 auto; background:#171a21; border:1px solid #262b36; border-radius:14px; padding:22px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8a8f9c; font-size:13px; margin-bottom:18px; }
  .semaforo { display:flex; align-items:center; gap:10px; padding:12px 14px; border-radius:10px; margin-bottom:16px; font-weight:600; }
  .dot { width:12px; height:12px; border-radius:50%; flex:0 0 auto; }
  .ok { background:#123822; color:#5fe08a; } .ok .dot { background:#5fe08a; }
  .warn { background:#3a2f10; color:#f2c14e; } .warn .dot { background:#f2c14e; }
  .bad { background:#3a1414; color:#ff8080; } .bad .dot { background:#ff8080; }
  .info { background:#12242f; color:#67c1ff; } .info .dot { background:#67c1ff; }
  .fila { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid #262b36; font-size:14px; }
  .fila:first-of-type { border-top:none; }
  .muted { color:#8a8f9c; }
  button, input { font: inherit; }
  input[type=text] { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #333a48; background:#0f1115; color:#e8e8ea; margin-bottom:10px; letter-spacing:2px; text-transform:uppercase; }
  button { padding:10px 16px; border-radius:8px; border:0; background:#3a6df0; color:#fff; cursor:pointer; font-weight:600; }
  button:hover { background:#2f5bd0; }
  button.secundario { background:#262b36; }
  button:disabled { opacity:.5; cursor:default; }
  .msg { font-size:13px; margin-top:10px; min-height:16px; }
  .msg.err { color:#ff8080; } .msg.ok { color:#5fe08a; }
  h2 { font-size:15px; margin:22px 0 6px; }
  .pin { font-size:30px; letter-spacing:8px; font-weight:800; color:#5fe08a; }
  .chip { display:inline-block; font-size:11px; padding:2px 8px; border-radius:99px; background:#262b36; color:#b9bfcc; margin-left:6px; }
  .hallazgo { padding:10px 0; border-top:1px solid #262b36; font-size:14px; }
  .hallazgo .acciones { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
  select { font: inherit; padding:9px 10px; border-radius:8px; border:1px solid #333a48; background:#0f1115; color:#e8e8ea; max-width:100%; }
  button.chico { padding:6px 10px; font-size:13px; }
  footer { text-align:center; color:#4c5261; font-size:12px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>LevoPrint · Agente de impresion</h1>
    <div class="sub">Ventana de estado local — no necesita internet para verse.</div>

    <div id="semaforo" class="semaforo info"><span class="dot"></span><span id="semaforoTexto">Cargando...</span></div>

    <div id="vinculoBox" style="display:none">
      <div class="fila"><b>Vincular este agente</b></div>
      <input id="codigo" type="text" maxlength="9" placeholder="CÓDIGO DE 9 CARACTERES">
      <button id="btnVincular">Vincular</button>
      <div id="msgVinculo" class="msg"></div>
    </div>

    <div id="estacionesBox"></div>

    <div class="fila">
      <span>Ancho de papel</span>
      <span id="anchoTexto" class="muted">-</span>
    </div>

    <div style="margin-top:14px; display:flex; gap:10px;">
      <button id="btnPrueba">Imprimir prueba</button>
      <button id="btn58" class="secundario">58mm</button>
      <button id="btn80" class="secundario">80mm</button>
    </div>
    <div id="msgPrueba" class="msg"></div>

    <h2>Impresion sin internet (red del local)</h2>
    <div class="sub" style="margin-bottom:8px">Las cajas y los mozos imprimen directo por la WiFi del local, aunque se caiga el internet.</div>
    <div id="lanBox" class="muted">-</div>
    <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
      <button id="btnPin">Activar impresion sin internet / emparejar un equipo</button>
    </div>
    <div id="pinBox" style="display:none; margin-top:10px">
      <div class="muted" style="font-size:13px">En la app: Estaciones &gt; LevoPrint en esta red &gt; escribe este PIN (vence en 10 min, sirve una vez):</div>
      <div id="pinTexto" class="pin">------</div>
    </div>
    <div id="equiposBox"></div>
    <div id="msgLan" class="msg"></div>

    <h2>Buscar impresoras</h2>
    <div class="sub" style="margin-bottom:8px">Busca impresoras USB de esta PC, de la red (puerto 9100) y Bluetooth instaladas en Windows.</div>
    <button id="btnBuscar">Buscar impresoras</button>
    <div id="msgBuscar" class="msg"></div>
    <div id="hallazgosBox"></div>

    <footer>&lt;Levodev.app /&gt;</footer>
  </div>

<script>
// [F2] Todo POST va con JSON (el servidor de esta ventana rechaza el resto:
// una pagina de internet no puede mandar ordenes a LevoPrint).
async function j(url, opts) {
  opts = opts || {};
  if (opts.method === 'POST') { opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}); if (!opts.body) opts.body = '{}'; }
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
let ultimoEstado = null;
function fmtTs(ts) { if (!ts) return 'nunca'; const d = new Date(ts); return d.toLocaleTimeString(); }

async function refrescar() {
  let e;
  try { e = await j('/estado'); } catch { e = null; }
  if (!e || !e.ok) return;

  const sem = document.getElementById('semaforo');
  const semTxt = document.getElementById('semaforoTexto');
  sem.className = 'semaforo';
  const mapa = {
    sin_configurar: ['bad', 'Falta configurar LEVO_URL/LEVO_ANON en levoprint.txt'],
    sin_vincular: ['warn', 'Sin vincular — ingresa tu codigo abajo'],
    imprimiendo: ['ok', 'Imprimiendo...'],
    sin_impresora: ['bad', 'Sin impresora / error en el ultimo trabajo'],
    sin_internet: ['warn', 'Sin internet — sigue imprimiendo lo que llegue por la red del local'],
    conectado: ['ok', 'Conectado — listo para imprimir'],
  };
  let [clase, texto] = mapa[e.semaforo] || ['info', 'Estado desconocido'];
  if (e.semaforo === 'desactivado') { clase = 'bad'; texto = e.desactivado || 'Equipo desactivado desde la consola'; }
  sem.classList.add(clase);
  semTxt.textContent = texto;

  // Desactivado: se puede vincular con un codigo nuevo sin perder el actual.
  document.getElementById('vinculoBox').style.display = (e.sinUrlAnon || (e.vinculado && !e.desactivado)) ? 'none' : 'block';

  const box = document.getElementById('estacionesBox');
  if (!e.estaciones || !e.estaciones.length) {
    box.innerHTML = e.vinculado ? '<div class="fila muted">Sin estaciones asignadas todavia.</div>' : '';
  } else {
    box.innerHTML = e.estaciones.map(function (est) {
      const via = (est.via && est.via !== 'sin impresora' ? est.via : 'SIN IMPRESORA — usa Buscar impresoras') +
        (est.fuente === 'local' ? (est.pendienteNube ? ' (en esta PC, falta avisar a la nube)' : ' (solo en esta PC)') : est.fuente === 'nube' ? ' (de la nube)' : '');
      const quitar = est.local ? ' <button class="secundario chico" data-desasignar="' + esc(est.id) + '">Quitar</button>' : '';
      return '<div class="fila"><span>' + esc(est.nombre) + (est.cola ? '<span class="chip">' + est.cola + ' en cola</span>' : '') + '</span><span class="muted">' + esc(via) + quitar + '</span></div>';
    }).join('');
  }
  ultimoEstado = e;
  pintarLan(e.lan || {});

  document.getElementById('anchoTexto').textContent = e.ancho + ' columnas (' + (e.ancho > 56 ? '80mm' : '58mm') + ')';
  document.getElementById('btnPrueba').disabled = !e.vinculado;
}

function pintarLan(l) {
  const box = document.getElementById('lanBox');
  if (!l.activo) box.textContent = 'Apagado (LEVO_LAN=0 en levoprint.txt).';
  else if (l.error) box.innerHTML = '<span style="color:#ff8080">' + esc(l.error) + '</span>';
  else if (!l.escuchando) box.textContent = l.modo === 'demanda' ? 'Cerrado: toca Activar impresion sin internet para abrirlo en la red del local.' : 'Iniciando...';
  else box.innerHTML = 'Escuchando en ' + (l.urls && l.urls.length ? l.urls.map(esc).join(' · ') : 'esta PC (sin WiFi/cable detectado)');
  const pinBox = document.getElementById('pinBox');
  pinBox.style.display = l.pin ? 'block' : 'none';
  document.getElementById('pinTexto').textContent = l.pin || '------';
  const eq = document.getElementById('equiposBox');
  eq.innerHTML = (l.equipos || []).map(function (q) {
    return '<div class="fila"><span>' + esc(q.nombre) + ' <span class="muted" style="font-size:12px">' + esc(q.ip || '') + '</span></span><button class="secundario chico" data-quitar="' + esc(q.id) + '">Quitar</button></div>';
  }).join('');
}

document.getElementById('btnPin').addEventListener('click', async function () {
  const r = await j('/lan/pin', { method: 'POST' });
  const msg = document.getElementById('msgLan');
  msg.textContent = r && r.ok ? 'PIN listo. Escribelo en el equipo que quieres emparejar.' : 'No se pudo generar el PIN.';
  msg.className = 'msg ' + (r && r.ok ? 'ok' : 'err');
  refrescar();
});

document.addEventListener('click', async function (ev) {
  const t = ev.target;
  if (!t || !t.getAttribute) return;
  const quitar = t.getAttribute('data-quitar');
  const desasignar = t.getAttribute('data-desasignar');
  const probar = t.getAttribute('data-probar');
  const asignar = t.getAttribute('data-asignar');
  if (quitar) { await j('/lan/quitar', { method: 'POST', body: JSON.stringify({ id: quitar }) }); refrescar(); }
  if (desasignar) { await j('/desasignar', { method: 'POST', body: JSON.stringify({ estacion: desasignar }) }); refrescar(); }
  if (probar || asignar) {
    const h = hallazgos[Number(probar || asignar)];
    const msg = document.getElementById('msgBuscar');
    if (!h) return;
    if (probar) {
      msg.textContent = 'Imprimiendo prueba en ' + h.nombre + '...'; msg.className = 'msg';
      const r = await j('/prueba', { method: 'POST', body: JSON.stringify({ transporte: h.transporte, destino: h.destino }) });
      msg.textContent = r && r.ok ? (r.aviso || 'Prueba enviada.') : ((r && r.mensaje) || 'No se pudo imprimir.');
      msg.className = 'msg ' + (r && r.ok ? 'ok' : 'err');
    } else {
      const sel = document.getElementById('est-' + asignar);
      const estacion = sel ? sel.value : '';
      if (!estacion) { msg.textContent = 'Elige la estacion (cocina, barra, caja).'; msg.className = 'msg err'; return; }
      const r = await j('/asignar', { method: 'POST', body: JSON.stringify({ estacion: estacion, transporte: h.transporte, destino: h.destino }) });
      msg.textContent = r && r.ok ? ('Listo: ' + h.nombre + ' imprime para ' + (r.estacion || 'la estacion') + '.' + (r.nube ? '' : ' (Se guardo en esta PC; se avisara a la nube cuando haya internet.)')) : ((r && r.mensaje) || 'No se pudo asignar.');
      msg.className = 'msg ' + (r && r.ok ? 'ok' : 'err');
      refrescar();
    }
  }
});

let hallazgos = [];
document.getElementById('btnBuscar').addEventListener('click', async function () {
  const btn = this;
  const msg = document.getElementById('msgBuscar');
  btn.disabled = true; msg.textContent = 'Buscando en USB, red y Bluetooth...'; msg.className = 'msg';
  const r = await j('/buscar', { method: 'POST' });
  btn.disabled = false;
  hallazgos = (r && r.impresoras) || [];
  const ests = (ultimoEstado && ultimoEstado.estaciones) || [];
  const opciones = '<option value="">Asignar a...</option>' + ests.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.nombre) + '</option>'; }).join('');
  msg.textContent = hallazgos.length ? (hallazgos.length + ' encontradas.') : 'No se encontro ninguna. Revisa el cable USB o que la impresora este en la misma red.';
  if (r && r.avisos && r.avisos.length) msg.textContent += ' (' + r.avisos.join(' · ') + ')';
  msg.className = 'msg ' + (hallazgos.length ? 'ok' : 'err');
  document.getElementById('hallazgosBox').innerHTML = hallazgos.map(function (h, i) {
    return '<div class="hallazgo"><b>' + esc(h.nombre) + '</b><span class="chip">' + esc(h.via) + '</span>' + (h.ticketera ? '<span class="chip">ticketera</span>' : '') +
      '<div class="muted" style="font-size:12px">' + esc(h.detalle || h.destino) + '</div>' +
      '<div class="acciones"><button class="secundario chico" data-probar="' + i + '">Probar</button>' +
      (ests.length ? '<select id="est-' + i + '">' + opciones + '</select><button class="chico" data-asignar="' + i + '">Asignar</button>' : '<span class="muted" style="font-size:12px">Vincula el agente para asignar estaciones.</span>') +
      '</div></div>';
  }).join('');
});

document.getElementById('btnVincular').addEventListener('click', async function () {
  const codigo = document.getElementById('codigo').value.trim();
  const msg = document.getElementById('msgVinculo');
  if (!codigo) { msg.textContent = 'Escribe el codigo.'; msg.className = 'msg err'; return; }
  msg.textContent = 'Vinculando...'; msg.className = 'msg';
  const r = await j('/vincular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: codigo }) });
  if (r && r.ok) { msg.textContent = 'Vinculado como ' + (r.nombre || 'estación') + '.' + (r.aviso ? ' ' + r.aviso : ''); msg.className = 'msg ok'; }
  else { msg.textContent = (r && r.mensaje) || 'No se pudo vincular.'; msg.className = 'msg err'; }
  refrescar();
});

document.getElementById('btnPrueba').addEventListener('click', async function () {
  const msg = document.getElementById('msgPrueba');
  msg.textContent = 'Imprimiendo...'; msg.className = 'msg';
  const r = await j('/prueba', { method: 'POST' });
  if (r && r.ok) { msg.textContent = r.aviso || 'Prueba enviada.'; msg.className = 'msg ok'; }
  else { msg.textContent = (r && r.mensaje) || (r && r.error) || 'No se pudo imprimir.'; msg.className = 'msg err'; }
  refrescar();
});

function cambiarAncho(v) {
  const msg = document.getElementById('msgPrueba');
  j('/ancho', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ancho: v }) })
    .then(function (r) { msg.textContent = (r && r.ok) ? 'Ancho actualizado.' : 'No se pudo cambiar.'; msg.className = 'msg ' + ((r && r.ok) ? 'ok' : 'err'); refrescar(); });
}
document.getElementById('btn58').addEventListener('click', function () { cambiarAncho(48); });
document.getElementById('btn80').addEventListener('click', function () { cambiarAncho(64); });

refrescar();
setInterval(refrescar, 2500);
</script>
</body>
</html>`;
}

async function manejarPrueba(req, res) {
  const body = await leerBodyJson(req);
  // [F2] Prueba de un hallazgo de "Buscar impresoras" (aun sin estacion):
  // no exige estar vinculado.
  if (body.transporte) {
    const r = await manejadoresLan.prueba({ transporte: body.transporte, destino: body.destino });
    if (!r.ok) guiEstado.ultimoError = { mensaje: r.mensaje || r.error, ts: Date.now() };
    return responderJson(res, r.ok ? 200 : 500, r);
  }
  if (faltaConfig()) return responderJson(res, 400, { ok: false, error: 'SIN_VINCULAR', mensaje: 'Primero vincula el agente.' });
  const est = body.estacion ? motor.estaciones.get(body.estacion) : [...motor.estaciones.values()][0];
  const ruta = est ? motor.ruta(est.id) : null;
  const texto = render({ tipo: 'PRUEBA', payload: {} });
  try {
    if (MODO_CONSOLA || !est || !ruta) {
      console.log('[prueba] ' + texto.replace(/[\x00-\x1f]/g, '').trim());
      return responderJson(res, 200, {
        ok: true,
        aviso: !est ? 'Sin estaciones asignadas: se mostro en consola.'
              : !ruta ? 'Sin impresora asignada: se mostro en consola. Usa Buscar impresoras.'
              : 'Modo consola: se mostro en consola.',
      });
    }
    await colas.encolar(ruta.transporte + '|' + ruta.destino, () => transportes.enviar(ruta, texto, { timeoutMs: 20000 }), 30000);
    guiEstado.ultimoOk = Date.now();
    return responderJson(res, 200, { ok: true, aviso: 'Prueba enviada a ' + est.nombre + ' (' + transportes.describir(ruta) + ').' });
  } catch (e) {
    guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
    return responderJson(res, 500, { ok: false, error: 'IMPRESION', mensaje: e.message });
  }
}

async function manejarVincular(req, res) {
  const body = await leerBodyJson(req);
  const r = await canjearCodigo(body.codigo);
  if (r.ok) {
    console.log('[gui] vinculado desde la ventana web. Arrancando ciclo de impresion...');
    // Token nuevo: vuelta inmediata con config fresca (arranca el bucle si
    // arrancar() no lo inicio, o corta la pausa de 45 s si estaba desactivado).
    despertarCiclo();
  }
  return responderJson(res, r.ok ? 200 : 400, r);
}

async function manejarAncho(req, res) {
  const body = await leerBodyJson(req);
  const v = parseInt(body.ancho, 10);
  if (!v || v < 20 || v > 100) return responderJson(res, 400, { ok: false, error: 'ANCHO_INVALIDO' });
  ANCHO = v;
  process.env.LEVO_ANCHO = String(v);
  const persistido = persistirAncho(v);
  return responderJson(res, 200, { ok: true, ancho: ANCHO, persistido });
}

// [F2] Asignar desde la ventana (funciona sin internet: queda en esta PC y se
// avisa a la nube si se puede, con <p>_agente_asignar).
async function manejarAsignar(req, res) {
  const b = await leerBodyJson(req);
  const est = motor.estaciones.get(b.estacion);
  if (!est) return responderJson(res, 400, { ok: false, error: 'ESTACION_DESCONOCIDA', mensaje: 'Elige una estacion de la lista.' });
  const err = validarDestino(b.transporte, b.destino);
  if (err) return responderJson(res, 400, { ok: false, error: 'DESTINO_INVALIDO', mensaje: err });
  // [QA F2 ALTO-1] Nace como asignacion LOCAL pendienteNube (imprime ya, aun
  // sin internet). Si la nube la acepta, se borra la local y manda la nube; si
  // no hay internet, el latido la reintenta.
  motor.asignar(est.id, b.transporte, String(b.destino), { pendienteNube: true });
  let enNube = false;
  if (!faltaConfig()) enNube = await avisarAsignacion(DEVICE, PREFIJO, est.id, motor.asignaciones[est.id]);
  console.log(`[asignar] ${est.nombre} -> ${transportes.describir({ transporte: b.transporte, destino: b.destino })}${enNube ? '' : ' (solo en esta PC)'}`);
  return responderJson(res, 200, { ok: true, estacion: est.nombre, nube: enNube });
}

// Ventana solo para esta PC: Host 127.0.0.1/localhost (anti DNS rebinding),
// y todo POST con JSON y sin Origin ajeno (una pagina de internet no puede
// mandar ordenes ni leer el PIN).
function guiPermitida(req) {
  const host = red.hostSinPuerto(req.headers.host);
  if (host !== '127.0.0.1' && host !== 'localhost') return false;
  if (req.method === 'POST') {
    if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return false;
    const o = req.headers.origin;
    if (o && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(o)) return false;
  }
  return true;
}

function abrirNavegador(url) {
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, () => {}); // si falla (sin entorno grafico), no pasa nada: la GUI sigue servida
  } catch { /* nada: entorno sin navegador */ }
}

// Intenta 9110..9114 por si el puerto base ya esta ocupado (dos agentes,
// otro programa, etc). No bloquea el ciclo de impresion si falla del todo.
function iniciarGui() {
  const servidor = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (!guiPermitida(req)) return responderJson(res, 403, { ok: false, error: 'NO_PERMITIDO' });
    if (req.method === 'GET' && url === '/') {
      // [qa5] Abrir la ventana con el equipo desactivado = reintento ya (con
      // tope de uno cada 10 s; /estado, que se sondea, NO despierta).
      if (guiEstado.desactivado && Date.now() - ultimoDespertarGui > 10000) {
        ultimoDespertarGui = Date.now();
        despertarCiclo();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(paginaHtml());
    }
    if (req.method === 'GET' && url === '/estado') return responderJson(res, 200, estadoActual());
    if (req.method === 'POST' && url === '/prueba') return void manejarPrueba(req, res);
    if (req.method === 'POST' && url === '/vincular') return void manejarVincular(req, res);
    if (req.method === 'POST' && url === '/ancho') return void manejarAncho(req, res);
    // [F2] emparejar equipos de la red, buscar y asignar impresoras
    // "Activar impresion sin internet": generar un PIN abre el 9120 (MEDIO-3).
    if (req.method === 'POST' && url === '/lan/pin') { const p = emparejador.nuevoPin(); asegurarLan(); return responderJson(res, 200, { ok: true, pin: p.valor, expira: p.expira }); }
    if (req.method === 'POST' && url === '/lan/quitar') return void leerBodyJson(req).then((b) => { const ok = emparejador.quitar(String(b.id || '')); asegurarLan(); responderJson(res, 200, { ok }); });
    if (req.method === 'POST' && url === '/buscar') return void buscarImpresoras().then((r) => responderJson(res, 200, r));
    if (req.method === 'POST' && url === '/asignar') return void manejarAsignar(req, res).catch((e) => responderJson(res, 500, { ok: false, mensaje: e.message }));
    if (req.method === 'POST' && url === '/desasignar') return void leerBodyJson(req).then((b) => { motor.desasignar(String(b.estacion || '')); responderJson(res, 200, { ok: true }); });
    responderJson(res, 404, { ok: false, error: 'NO_ENCONTRADO' });
  });
  function intentarPuertos(intento) {
    if (intento > 4) { console.error('[gui] no se pudo abrir ningun puerto (9110-9114); sigo sin ventana.'); return; }
    const puerto = PUERTO_GUI_BASE + intento;
    servidor.removeAllListeners('error');
    servidor.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') { intentarPuertos(intento + 1); }
      else console.error('[gui] error de servidor:', e.message);
    });
    servidor.listen(puerto, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${puerto}`;
      console.log('[gui] ventana disponible en ' + url);
      if (!SIN_VENTANA) abrirNavegador(url);
    });
  }
  intentarPuertos(0);
}

// [QA F2 BAJO] Una sola instancia por carpeta: dos LevoPrint abiertos se
// pelearian el diario, el puerto 9120 y los trabajos de la nube.
const CANDADO = path.join(BASE_DIR, 'levoprint.lock');
function tomarCandado() {
  try {
    const pid = parseInt(fs.readFileSync(CANDADO, 'utf8'), 10);
    if (pid && pid !== process.pid) {
      let vivo = false;
      try { process.kill(pid, 0); vivo = true; } catch (e) { vivo = e.code === 'EPERM'; }
      if (vivo) {
        console.error(`LevoPrint ya esta abierto en esta PC (proceso ${pid}). Cierra esa ventana antes de abrir otra.`);
        pausarYSalir(1);
        return false;
      }
    }
  } catch { /* no hay candado */ }
  try {
    fs.writeFileSync(CANDADO, String(process.pid));
    process.on('exit', () => { try { if (fs.readFileSync(CANDADO, 'utf8') === String(process.pid)) fs.unlinkSync(CANDADO); } catch { /* nada */ } });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => process.exit(0));
  } catch { /* carpeta de solo lectura: se sigue sin candado */ }
  return true;
}

async function arrancar() {
  if (!tomarCandado()) return;
  usbwin.configurar(BASE_DIR);
  await canjearCodigo();
  if (faltaUrlAnon()) { abortarSinConfig(); return; }
  console.log(`LevoPrint agente de impresion v${VERSION} (red del local + USB + emparejamiento por codigo) — <Levodev.app />`);
  console.log(MODO_CONSOLA ? 'MODO CONSOLA (sin impresoras reales)' : 'Modo impresión real');
  if (motor.estaciones.size) console.log(`[cfg] ${motor.estaciones.size} estaciones guardadas en esta PC (sirven aunque no haya internet).`);
  iniciarGui();
  asegurarLan();
  // El PIN vence a los 10 min: si nadie se emparejo, el puerto se vuelve a cerrar.
  setInterval(asegurarLan, 30000).unref();
  if (!faltaConfig()) ciclo();
  else console.log('Falta vincular: abre la ventana de LevoPrint (o entra tu codigo por /vincular) para terminar la configuracion.');
}
arrancar();
