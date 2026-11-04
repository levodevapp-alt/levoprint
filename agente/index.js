// ============================================================
// LevoPrint · Agente de impresión v1.13 (impresora por estación: red o USB, búsqueda sola) · LevoDev
// Corre en la PC del local. Poll cada 2-6 s a <prefijo>_print_tomar de CADA app
// vinculada (KOMO, KIPU, KUTI...), renderiza ESC/POS y lo manda a la impresora
// de cada estación: por red (IP:puerto) o por una impresora instalada en esta
// PC («USB», cola de Windows en RAW). Se empaqueta a LevoPrint.exe (Node SEA).
// [LP-F3/F4] 1.13: busca impresoras solo (red :9100 y colas de Windows), las
// informa a <prefijo>_agente_impresoras y la ventana pregunta «¿Dónde está la
// impresora de <estación>?» (prueba → «¿Salió?» → <prefijo>_agente_estacion_elegir).
// Con un backend sin esas RPC se comporta como la 1.12 (solo IP) por 30 min.
// También adopta el vínculo de komo-agente.txt y ayuda a retirar KOMO Agente.
// [LP-U1] Instalación en 3 pasos: descargar desde la app → abrir → escribir el
// código (o nada, si el nombre del .exe ya lo trae). URL y anon del proyecto
// compartido vienen DENTRO del programa; "levoprint.txt" (junto al .exe) es
// opcional y sirve de override / memoria:
//   LEVO_VINCULOS=komo:<device>,kuti:<device>   (lo escribe el propio agente)
//   LEVO_URL / LEVO_ANON   (opcional: otro proyecto Supabase)
//   LEVO_MODO=consola      (opcional: imprime a consola, sin impresora)
//   LEVO_INICIO=0          (lo escribe el botón «Quitar» del arranque con Windows)
// Compatibilidad: LEVO_DEVICE + LEVO_PREFIJO (config vieja de un solo vínculo)
// se migran a LEVO_VINCULOS al arrancar.
// Sin dependencias: Node >= 18 (fetch + net nativos).
// ============================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');

// --- ¿corro como .exe (SEA) o como `node index.js`? ---
// Empaquetado como Single Executable App, `__dirname` no apunta a una
// carpeta real: la config debe leerse JUNTO AL .exe (dirname del propio
// ejecutable). En desarrollo (`node index.js`) sí vale `__dirname`.
let esExe = false;
try { esExe = require('node:sea').isSea(); } catch { esExe = false; }
const BASE_DIR = esExe ? path.dirname(process.execPath)
                       : (typeof __dirname === 'string' ? __dirname : process.cwd());

// [LP-U1] Carpeta de levoprint.txt / levoprint.log: junto al .exe (lo de
// siempre). Si ahí no se puede escribir (p. ej. Archivos de programa o un USB
// de solo lectura) y aún no hay .txt, se usa %LOCALAPPDATA%\LevoPrint: sin
// esto el vínculo se perdería al cerrar el programa. Se decide UNA vez.
const DIR_RESPALDO = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'LevoPrint') : null;
function puedeEscribir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.levoprint-prueba');
    fs.writeFileSync(p, '');
    fs.unlinkSync(p);
    return true;
  } catch { return false; }
}
const DIR_TXT = (fs.existsSync(path.join(BASE_DIR, 'levoprint.txt')) || !DIR_RESPALDO || puedeEscribir(BASE_DIR))
  ? BASE_DIR : DIR_RESPALDO;
const RUTA_TXT = path.join(DIR_TXT, 'levoprint.txt');

// --- log a archivo (para soporte remoto) ---
// Todo lo que sale por pantalla se guarda tambien en levoprint.log,
// junto al programa, para que si la ventana se cierra igual quede el
// rastro y el dueño pueda mandarnos el archivo. Se recorta si crece.
const LOG_FILE = path.join(DIR_TXT, 'levoprint.log');
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
// [LP-U1] Un valor de la plantilla vieja sin completar («TU-PROYECTO»,
// «PEGA-AQUI...») se IGNORA: así manda el valor que trae el programa.
(function cargarConfig() {
  const candidatos = ['levoprint.txt', 'levoprint.config.txt', '.env'];
  const dirs = DIR_TXT === BASE_DIR ? [BASE_DIR] : [DIR_TXT, BASE_DIR];
  for (const f of dirs.flatMap((d) => candidatos.map((n) => path.join(d, n)))) {
    if (!fs.existsSync(f)) continue;
    // [canje-v3] El .txt viene del Bloc de notas: CRLF y a veces BOM UTF-8
    // al inicio (que pegaria al primer nombre de clave). Se limpian ambos.
    const crudo = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    for (const linea of crudo.split(/\r\n|\r|\n/)) {
      if (/^\s*(#|$)/.test(linea)) continue;              // comentarios y vacias
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !/TU-PROYECTO|PEGA-AQUI/.test(m[2]) && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
})();

// [LP-U1] Proyecto Supabase COMPARTIDO por KOMO, KIPU y KUTI (el mismo de
// levoprint.sql "lp_supabase_url"/"lp_anon_key" y de Proyectos.kt del APK).
// La anon es PÚBLICA (va en el front de las 3 apps): NUNCA poner aquí la
// service role. Con esto el dueño vincula solo con el código, sin .txt.
const URL_DEFECTO = 'https://krfljsososdakbatevci.supabase.co';
const ANON_DEFECTO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZmxqc29zb3NkYWtiYXRldmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxOTU4MjQsImV4cCI6MjEwMzc3MTgyNH0.nYjVS4UW3jcOC_ho8UKt6H8j1ix_WgoMDyywdfBNlMs';
const URL_BASE = process.env.LEVO_URL || process.env.KOMO_URL || URL_DEFECTO;
const ANON = process.env.LEVO_ANON || process.env.KOMO_ANON || ANON_DEFECTO;

// [LP-U1] Varias apps en un mismo LevoPrint: lista de vínculos. Cada uno es
// { prefijo, device, nombre } + su estado en vivo (estaciones, desactivado...).
// Se guarda en levoprint.txt como LEVO_VINCULOS=komo:<device>:<nombre>,...
// (nombre con encodeURIComponent: puede traer «:» o «,»). La config vieja de
// un solo vínculo (LEVO_DEVICE + LEVO_PREFIJO, o KOMO_DEVICE) se lee SOLO si
// no hay LEVO_VINCULOS, y se migra al arrancar (migrarConfigVieja).
let vinculos = [];
// Prefijo «en curso» para el render local (firma/pie de marca, mensajes de la
// consola). El ciclo y la prueba lo fijan al de cada vínculo justo antes de
// renderizar (render es síncrono: no se cruza con otra vuelta).
let PREFIJO = 'komo';
function nuevoVinculo(prefijo, device, nombre) {
  return {
    prefijo: String(prefijo || 'komo').trim().toLowerCase(), device: String(device || '').trim(), nombre: String(nombre || ''),
    estaciones: new Map(), cicloConfig: 0, ultimaSync: null, desactivado: null, proximoIntento: 0,
    // [LP-F3] destino por estación (<prefijo>_agente_impresoras). transporte: null = aún no se sabe,
    // true = el servidor tiene la RPC, false = backend viejo (modo 1.12 hasta sinTransporteHasta).
    destinos: new Map(), transporte: null, sinTransporteHasta: 0, estacionVinculo: null,
    md5Informado: '', informadoTs: 0, buscadoPendiente: false, preguntar: false,
  };
}
const esDeviceValido = (d) => /^[0-9a-f-]{20,}$/i.test(String(d || '')) && !/PEGA-AQUI/.test(String(d));
(function leerVinculos() {
  const crudo = String(process.env.LEVO_VINCULOS || '').trim();
  if (crudo) {
    for (const parte of crudo.split(',')) {
      const [pfx, dev, nom] = parte.split(':');
      let nombre = '';
      try { nombre = decodeURIComponent(nom || ''); } catch { nombre = ''; }
      if (pfx && esDeviceValido(dev) && !vinculos.some((v) => v.prefijo === pfx.trim().toLowerCase())) vinculos.push(nuevoVinculo(pfx, dev, nombre));
    }
  } else {
    const dev = process.env.LEVO_DEVICE || process.env.KOMO_DEVICE;
    if (esDeviceValido(dev)) vinculos.push(nuevoVinculo(process.env.LEVO_PREFIJO || 'komo', dev, ''));
  }
  if (vinculos.length) PREFIJO = vinculos[0].prefijo;
})();
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
// [LP-U1] Código en el NOMBRE del .exe: la app puede entregar el programa como
// «LevoPrint-K7ABCD234.exe» o «LevoPrint (K-7ABC-D234).exe» (el navegador
// agrega « (1)» si se baja dos veces). Al abrirlo se vincula solo, sin
// escribir nada. El acceso directo de Inicio apunta a ESE MISMO .exe: el
// código ya canjeado se recuerda en LEVO_CODIGOS_ARCHIVO (lista: varios .exe
// pueden compartir carpeta y .txt, p. ej. Descargas) para no volver a
// intentarlo en cada arranque. Solo se acepta el formato real (letra de app +
// 8 del alfabeto sin ambiguos): «LevoPrint-Windows.exe» no dispara nada.
function codigoDelNombre(nombreArchivo) {
  const base = String(nombreArchivo || '')
    .replace(/\.exe$/i, '')
    .replace(/(\s*\(\d+\))+\s*$/, '')            // « (1)», « (2)» del navegador
    .replace(/^\s*levo[\s_.-]*print/i, '');      // el nombre del programa no es parte del código
  for (const c of [base, ...base.split(/[\s_()[\]{}]+/)]) {
    const k = normalizarCodigo(c);
    if (CODIGO_FORMATO.test(k)) return k;
  }
  return '';
}
// En desarrollo (node index.js) se puede simular el nombre con LEVO_NOMBRE_EXE.
const CODIGO_ARCHIVO = codigoDelNombre(esExe ? path.basename(process.execPath) : (process.env.LEVO_NOMBRE_EXE || ''));
const MODO_CONSOLA = ((process.env.LEVO_MODO || process.env.KOMO_MODO) || '') === 'consola';
const INTERVALO_MS = 2000;      // con trabajo reciente: la comanda sale al toque
const INTERVALO_MAX_MS = 6000;  // sin trabajo: se espacia de a poco hasta 6 s
// estaciones/impresoras: cada minuto (solo en desarrollo, LEVO_PRUEBA_CONFIG_MS acorta la espera para las pruebas)
const CONFIG_CADA_MS = (!esExe && parseInt(process.env.LEVO_PRUEBA_CONFIG_MS || '', 10)) || 60000;
// [O-23 · QA MEDIO-2] Versión de este agente: va en <prefijo>_agente_config (p.version = 'exe/1.13'). KUTI
// (kuti_turno_print) solo manda el papel TURNO a un local cuyos agentes vivos lo saben dibujar; KOMO/KIPU la ignoran.
const VERSION_AGENTE = '1.13';
let ANCHO = Math.min(100, Math.max(20, parseInt(process.env.LEVO_ANCHO || '48', 10) || 48)); // [Re-QA] 20–100 como la ventana // columnas típicas de térmica 58mm (48) u 80mm (64/72)
// [ventana] LEVO_SINVENTANA=1 (o corriendo como servicio de Windows): no abrir
// navegador, pero la mini-GUI web se sigue sirviendo igual (soporte remoto).
// [MM3-01 · MM3-P1 · 4-nov] LEVO_IMAGEN=0 (o no/false/texto): impresora vieja sin soporte de imagen (GS v 0) → el pie
// de marca sale solo en texto. Se cambia también desde la ventana («Pie con logo») y se guarda en levoprint.txt.
let CON_IMAGEN = !/^(0|no|false|texto)$/i.test(String(process.env.LEVO_IMAGEN || '1').trim());
// [LP-U1] «--inicio» lo pone el acceso directo de la carpeta Inicio de Windows: al encender la PC el
// agente arranca minimizado y SIN abrir el navegador (la ventana sigue servida en 127.0.0.1:9110).
const DESDE_INICIO = process.argv.slice(2).includes('--inicio');
const SIN_VENTANA = DESDE_INICIO || /^(1|true|si|s[ií])$/i.test(String(process.env.LEVO_SINVENTANA || ''));
const PUERTO_GUI_BASE = parseInt(process.env.LEVO_PUERTO_GUI || '9110', 10) || 9110;

// [LP-U1] Ya no hace falta la plantilla con URL/ANON/DEVICE para pegar: el
// programa trae el proyecto compartido y se vincula con el código desde la
// ventana. faltaUrlAnon() queda solo por si alguien deja LEVO_URL/LEVO_ANON
// vacíos a propósito en el entorno (no ocurre con el .txt: vacío se ignora).
function faltaConfig() { return !vinculos.length; }
function faltaUrlAnon() { return !URL_BASE || !ANON; }

// [MM4-08] Tambien sin guiones ni puntos, por si la consola lo muestra en grupos (\u00ABK-ABCD-2345\u00BB):
// solo quedan letras y numeros (mismo criterio que el APK; CODIGO_FORMATO rechaza el resto).
function normalizarCodigo(c) {
  return String(c || '').replace(/[^0-9A-Za-z]+/g, '').toUpperCase();
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
    e.http = r.status;
    try { const j = JSON.parse(txt) || {}; e.pg = String(j.message || '').trim(); e.codigo = String(j.code || '').trim(); } catch { e.pg = ''; e.codigo = ''; }
    throw e;
  }
  return r.json();
}
const esAgenteInvalido = (e) => !!(e && e.pg === 'AGENTE_INVALIDO');
// [LP-F3] Backend sin el módulo levoprint_transporte: PostgREST responde 404 con code PGRST202
// («Could not find the function»). El agente sigue como la 1.12 (solo IP) y no reintenta en 30 min.
const esRpcAusente = (e) => !!(e && (e.codigo === 'PGRST202' || e.http === 404 || /could not find the function/i.test(e.pg || '')));

// --- ESC/POS ---
const ESC = '\x1b', GS = '\x1d';
const CMD = {
  init: ESC + '@',
  centro: ESC + 'a\x01', izq: ESC + 'a\x00',
  negritaOn: ESC + 'E\x01', negritaOff: ESC + 'E\x00',
  grande: GS + '!\x11', normal: GS + '!\x00',
  // [O-23] triple de ancho y alto: el número del turno sin cita se lee desde lejos
  enorme: GS + '!\x22',
  corte: '\n\n\n' + GS + 'V\x00',
};
const linea = (c = '-') => c.repeat(ANCHO) + '\n';
const fila = (izq, der) => {
  izq = String(izq); der = String(der);
  const esp = Math.max(1, ANCHO - izq.length - der.length);
  return izq + ' '.repeat(esp) + der + '\n';
};
const money = (n) => 'S/ ' + Number(n).toFixed(2);

// [MM3-01 · 4-nov] Comanda de cocina: jerarquía para leerla de pie y de lejos, y SIN marca. Título chico, la
// MESA enorme (GS ! 0x22), mozo y hora en negrita, cada ítem en doble alto y negrita (el nombre largo baja con
// sangría) y su nota en negrita debajo. Mismo papel que komo-print / kipu-print, el agente de KOMO y el APK.
const alto = GS + '!\x01';
function renderComanda(pl) {
  let t = CMD.init + CMD.centro;
  t += pl.correccion ? CMD.negritaOn + CMD.grande + '*** CORRECCION ***\n' + CMD.normal + CMD.negritaOff : CMD.negritaOn + 'COMANDA\n' + CMD.negritaOff;
  const mesa = 'MESA ' + (pl.mesa || '-');
  t += CMD.negritaOn + (mesa.length * 3 <= ANCHO ? GS + '!\x22' : mesa.length * 2 <= ANCHO ? CMD.grande : '') + mesa + '\n' + CMD.normal + CMD.negritaOff;
  t += CMD.izq + linea('=');
  t += CMD.negritaOn + fila('Mozo: ' + (pl.mozo || '-'), pl.hora || '') + CMD.negritaOff;
  if (pl.ronda) t += fila('Ronda ' + pl.ronda, '');
  t += linea('=');
  if (pl.mensaje) t += CMD.negritaOn + CMD.grande + pl.mensaje + '\n' + CMD.normal + CMD.negritaOff + linea();
  for (const it of pl.items || []) {
    const cab = fmtCant(it.cantidad) + ' x ';
    (envolver(it.nombre, Math.max(8, ANCHO - cab.length)).length ? envolver(it.nombre, Math.max(8, ANCHO - cab.length)) : ['(sin nombre)']).forEach((l, i) => {
      t += CMD.negritaOn + alto + (i === 0 ? cab : ' '.repeat(cab.length)) + l + '\n' + CMD.normal + CMD.negritaOff;
    });
    if (it.nota) for (const l of envolver(it.nota, ANCHO - 6)) t += CMD.negritaOn + '   >> ' + l + CMD.negritaOff + '\n';
  }
  if (pl.nota) { t += linea(); for (const l of envolver('NOTA: ' + pl.nota, ANCHO)) t += CMD.negritaOn + l + CMD.negritaOff + '\n'; }
  // [MM4-09 · P6 · 3-nov] La comanda no lleva pie: al cliente nunca le llega y eran líneas de rollo
  // por ronda que se botan. Solo el corte (el pie sigue en precuenta, ticket, CPE y carta QR).
  t += linea('=') + CMD.corte;
  return t;
}

function renderPrecuenta(pl) {
  let t = CMD.init + CMD.centro + CMD.grande + 'PRECUENTA\n' + CMD.normal;
  t += `MESA ${pl.mesa}\n`;
  if (pl.cuenta && pl.cuenta.de) t += CMD.negritaOn + `CUENTA ${pl.cuenta.n} de ${pl.cuenta.de}\n` + CMD.negritaOff;
  t += CMD.izq + linea('=');
  t += fila(`Mozo: ${pl.mozo || '-'}`, pl.hora || '');
  t += linea();
  for (const it of pl.items || []) {
    t += fila(`${fmtCant(it.cantidad)} ${it.nombre}`.slice(0, ANCHO - 9), money(it.cantidad * it.precio));
  }
  t += linea('=');
  t += CMD.negritaOn + fila('TOTAL', money(pl.total)) + CMD.negritaOff;
  t += linea('=') + CMD.centro;
  t += `[QR] ${pl.qr}\n`; // v1: texto; QR gráfico ESC/POS en F2 (el cajero escanea desde su celular)
  t += 'NO ES COMPROBANTE DE PAGO\n';
  t += firma(pl) + CMD.corte;
  return t;
}

const fmtCant = (n) => (Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(3));

// --- QR gráfico ESC/POS (GS ( k, modelo 2). Soportado por la mayoría de térmicas 58/80mm. ---
function qrEscPos(texto, tam = 5) {
  const data = Buffer.from(String(texto || ''), 'utf8');
  const len = data.length + 3;
  const pL = String.fromCharCode(len & 0xff), pH = String.fromCharCode((len >> 8) & 0xff);
  return GS + '(k\x04\x00\x31\x41\x32\x00'                    // modelo 2
       + GS + '(k\x03\x00\x31\x43' + String.fromCharCode(tam)   // tamaño de módulo
       + GS + '(k\x03\x00\x31\x45\x31'                         // corrección M
       + GS + '(k' + pL + pH + '\x31\x50\x30' + data.toString('binary') // almacenar
       + GS + '(k\x03\x00\x31\x51\x30';                        // imprimir
}

// [QA M2 · 4-nov] El nombre del negocio va en doble ancho (cabe la mitad de las columnas): se parte por palabras en varios
// renglones dobles; una palabra que sola no cabe baja a tamaño normal en negrita (partida al ancho si hace falta). Nunca se pierde un carácter.
// [Re-QA B4] Mayúsculas sin salir de latin1: lo que no cabe en un byte sale «?» (igual en los 6 render; la impresora no lo entiende).
const mayus = (s) => s.toUpperCase().replace(/[^\x00-\xff]/g, '?');
function negocioGrande(nombre) {
  const mitad = Math.floor(ANCHO / 2);
  let out = '', l = '';
  const sale = (s) => { out += CMD.negritaOn + (s.length <= mitad ? CMD.grande : '') + s + '\n' + CMD.normal + CMD.negritaOff; };
  for (const w of mayus(String(nombre == null ? '' : nombre)).split(/\s+/).filter(Boolean)) {
    if (w.length > mitad) { if (l) { sale(l); l = ''; } for (let i = 0; i < w.length; i += Math.max(1, ANCHO)) sale(w.slice(i, i + ANCHO)); continue; }
    if (l && l.length + 1 + w.length <= mitad) l += ' ' + w; else { if (l) sale(l); l = w; }
  }
  if (l) sale(l);
  return out;
}

// [QA B3] En modo consola el logo (GS v 0 + mapa de bits) no se vuelca como basura: sale «[logo]».
function paraConsola(t, sep) {
  let i;
  while ((i = t.indexOf('\x1dv0')) >= 0) {
    const xl = t.charCodeAt(i + 4) + 256 * t.charCodeAt(i + 5), yl = t.charCodeAt(i + 6) + 256 * t.charCodeAt(i + 7);
    if (!(xl * yl >= 0)) { t = t.slice(0, i) + '[logo]'; break } // [Re-QA BAJO-7] encabezado incompleto: no reinyectar
    t = t.slice(0, i) + '[logo]' + t.slice(i + 8 + xl * yl);
  }
  return t.replace(/[\x00-\x1f]/g, sep || '').trim();
}

// [F2] Ticket interno de cobro (no es comprobante)
function renderTicket(pl) {
  // Retail (KIPU) no manda mesa; restaurante (KOMO) sí. Un solo template
  // sirve a ambos: con negocio + nota para la tienda, con mesa/mozo para el resto.
  const retail = !pl.mesa;
  let t = CMD.init + CMD.centro;
  if (pl.negocio) t += negocioGrande(pl.negocio);
  // [kuti] local (si el negocio tiene varios) y titulo del alquiler de silla; KOMO/KIPU no mandan local ni refTipo.
  if (pl.local) t += String(pl.local) + '\n';
  t += CMD.grande + (retail ? (pl.refTipo === 'ALQUILER' ? 'ALQUILER DE SILLA\n' : 'VENTA\n') : 'COBRADO\n') + CMD.normal;
  if (!retail) t += CMD.grande + 'MESA ' + (pl.mesa || '-') + '\n' + CMD.normal;
  t += CMD.izq + linea('=');
  if (pl.nota) t += 'Nota: ' + pl.nota + '\n';
  const quien = pl.vendedor || pl.mozo || '';
  t += fila(quien ? ((retail ? 'Atendio: ' : 'Mozo: ') + quien) : '', pl.hora || '');
  // [kuti] cliente (en alquiler, el profesional) y el profesional de cada servicio en su propia linea.
  if (pl.cliente) t += 'Cliente: ' + pl.cliente + '\n';
  t += linea();
  for (const it of pl.items || []) {
    t += fila((fmtCant(it.cantidad) + ' ' + it.nombre).slice(0, ANCHO - 9), money(it.cantidad * it.precio));
    if (it.profesional) t += '   - ' + it.profesional + '\n';
  }
  t += linea('=') + CMD.negritaOn + fila('TOTAL', money(pl.total)) + CMD.negritaOff;
  for (const p of pl.pagos || []) t += fila('  ' + p.medio, money(p.monto));
  // [kuti] Propinas APARTE (no suman al total). KOMO/KIPU no mandan "propinas".
  if (Array.isArray(pl.propinas) && pl.propinas.length) {
    t += linea() + 'PROPINAS (aparte, no suman al total)\n';
    for (const p of pl.propinas) t += fila(('  ' + p.profesional + ' (' + p.medio + ')').slice(0, ANCHO - 12), money(p.monto));
  }
  t += linea('=') + CMD.centro + 'NO ES COMPROBANTE DE PAGO\n';
  t += firma(pl) + CMD.corte;
  return t;
}

// [F4] Comprobante electrónico (boleta/factura) con QR SUNAT

// --- Monto en letras (exigido por SUNAT en la representacion impresa) ---
function numeroALetras(num){
  const U=['','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE','DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISEIS','DIECISIETE','DIECIOCHO','DIECINUEVE','VEINTE'];
  const D=['','','','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
  const C=['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];
  function centenas(n){ if(n===100) return 'CIEN'; let t='';
    const c=Math.floor(n/100), r=n%100; if(c) t+=C[c]+' ';
    if(r<=20) t+=U[r]; else { const d=Math.floor(r/10), u=r%10;
      if(d===2) t+= (u? 'VEINTI'+U[u] : 'VEINTE');
      else t+= D[d] + (u? ' Y '+U[u] : ''); }
    return t.trim(); }
  function seccion(n){ let t='';
    const mill=Math.floor(n/1000000); n%=1000000;
    if(mill) t+= (mill===1? 'UN MILLON ' : centenas(mill)+' MILLONES ');
    const mil=Math.floor(n/1000); n%=1000;
    if(mil) t+= (mil===1? 'MIL ' : centenas(mil)+' MIL ');
    if(n) t+= centenas(n);
    return t.trim() || 'CERO'; }
  const e=Math.floor(Number(num||0)); const cent=Math.round((Number(num||0)-e)*100);
  return seccion(e)+' CON '+String(cent).padStart(2,'0')+'/100 SOLES';
}
function denomCpe(tipo){ const t=String(tipo||'').toUpperCase();
  if(t.includes('FACTURA')) return 'FACTURA ELECTRONICA';
  if(t.includes('BOLETA')) return 'BOLETA DE VENTA ELECTRONICA';
  if(t.includes('CREDITO')) return 'NOTA DE CREDITO ELECTRONICA';
  if(t.includes('DEBITO')) return 'NOTA DE DEBITO ELECTRONICA';
  return t || 'COMPROBANTE'; }

function renderCpe(pl) {
  const e = pl.empresa || {}, c = pl.cliente || {}, tot = pl.totales || {};
  const numero = pl.serie + '-' + String(pl.numero).padStart(8, '0');
  let t = CMD.init + CMD.centro + CMD.negritaOn + (e.razonSocial || e.nombre || '') + '\n' + CMD.negritaOff;
  if (e.ruc) t += 'RUC ' + e.ruc + '\n';
  if (e.direccion) t += e.direccion + '\n';
  t += linea('=') + CMD.negritaOn + denomCpe(pl.tipo) + '\n' + CMD.grande + numero + '\n' + CMD.normal + CMD.negritaOff;
  if (pl.estado === 'STUB') t += '*** MODO PRACTICA - SIN VALOR ***\n';
  t += CMD.izq + linea('=');
  t += fila('Fecha: ' + (pl.fecha || ''), '');
  // retail: el CPE no lleva mesa/mozo
  t += 'Cliente: ' + (c.nombre || 'CLIENTE VARIOS') + '\n';
  if (c.doc && c.doc !== '0') t += (c.tipoDoc || 'DOC') + ': ' + c.doc + '\n';
  if (c.direccion) t += c.direccion + '\n';
  t += linea();
  for (const it of pl.items || []) t += fila((fmtCant(it.cantidad) + ' ' + it.nombre).slice(0, ANCHO - 10), money(it.total));
  t += linea();
  const n = (x) => Number(x || 0);
  if (n(tot.gravada) > 0) t += fila('OP. GRAVADA', money(tot.gravada));
  if (n(tot.exonerada) > 0) t += fila('OP. EXONERADA', money(tot.exonerada));
  if (n(tot.inafecta) > 0) t += fila('OP. INAFECTA', money(tot.inafecta));
  if (n(tot.igv) > 0) t += fila('IGV 18%', money(tot.igv));
  t += CMD.negritaOn + fila('TOTAL', money(pl.total)) + CMD.negritaOff;
  t += CMD.izq + 'SON: ' + numeroALetras(pl.total) + '\n';
  for (const p of pl.pagos || []) t += fila('  ' + p.medio, money(p.monto));
  t += linea('=') + CMD.centro;
  if (pl.qr) t += qrEscPos(pl.qr) + '\n';
  if (pl.hash) t += 'Hash: ' + String(pl.hash).slice(0, 28) + '\n';
  t += 'Representacion impresa del\ncomprobante electronico.\nConsulte en sunat.gob.pe\n';
  t += firma(pl) + CMD.corte;
  return t;
}

// [F-carta] QR de la carta virtual: título + QR grande + pie.
function renderCartaQr(pl) {
  let t = CMD.init + CMD.centro + CMD.negritaOn + CMD.grande + (pl.titulo || '') + '\n' + CMD.normal + CMD.negritaOff;
  t += '\x1b\x21\x00' + (pl.sub || 'Escanea nuestra carta') + '\n\n';
  if (pl.url) t += qrEscPos(pl.url, 8) + '\n';
  t += '\x1b\x21\x00' + (pl.url || '') + '\n';
  t += firma(pl) + CMD.corte;
  return t;
}

// [MM3-01 · MM3-P1 · 4-nov] Pie de marca del ticket térmico (IDENTIDAD_VISUAL §12.12). El ticket es del
// NEGOCIO del cliente (su nombre va arriba); LevoDev va discreta al pie: isotipo D2 Yupana en 1 bit (64x64
// puntos, GS v 0; mapa generado por levodev-modules/tools/marca/isotipo_termico.mjs, el mismo de
// komo-print/kipu-print/kuti-print, el agente de KOMO y el APK) + «Hecho con <APP> - levodev.app» + el lema
// «Tu negocio, inteligente y bajo control.». Sin ciudades, sin país, sin precios, sin invitación (MM3-P5: la
// invitación va solo en el ticket digital). El nombre sale de la configuración del local (PREFIJO: komo/kipu/
// kuti); si no se conoce, del payload; si tampoco, «LevoDev - levodev.app». ASCII puro [QA MM3 · M1]: el 0xB7
// y las tildes dependen de la página de códigos. Bajo 40 columnas (58 mm) el lema va en dos líneas. Sin imagen
// (LEVO_IMAGEN=0 o payload.sinImagen) las mismas líneas salen solo en texto.
const APPS_PIE = { komo: 'KOMO', kipu: 'KIPU', kuti: 'KUTI' };
const ISOTIPO_B64 = 'P/+AAAAAD8B//8AAAAB/8P//4AAAAP/4///gAAAB//z//+AAAAH//v//4AAAA//+///gAAAD/////+AAAAf/////4AAAB//////gAAAH/////+AAAAf/////4AAAB//////gAAAD//7//+AAAAP//v//4AAAAf/+///gAAAB//z//+AAAAD/+H//wAAAAD/gP/+AAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAB//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/+A//8B//x//8H//4P//v//4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f//3//wf//g//+P/+A//8B//w=';
const ISOTIPO = '\x1bJ\x08' + '\x1dv0\x00\x08\x00\x40\x00' + Buffer.from(ISOTIPO_B64, 'base64').toString('binary') + '\x1bJ\x06';
function pieMarca(app, ancho, imagen){
  const a=String(app||'').trim().toUpperCase();
  const lema=ancho>=40?'Tu negocio, inteligente y bajo control.\n':ancho>=24?'Tu negocio, inteligente\ny bajo control.\n':'Tu negocio,\ninteligente y\nbajo control.\n';
  // [Re-QA B4] bajo 28 columnas «Hecho con <APP> - levodev.app» no cabe: la dirección baja a su renglón.
  let quien=APPS_PIE[a.toLowerCase()]?'Hecho con '+a+' - levodev.app':'LevoDev - levodev.app';
  if(quien.length>ancho) quien=quien.replace(' - ','\n');
  return ((imagen===undefined?CON_IMAGEN:imagen)?ISOTIPO:'')+quien+'\n'+lema;
}

// [MM4-06 · 3-nov] Papel corto al vincular: el cajero ve en papel que funciona. «nombre» es el del
// canje («<estación> · <negocio>»): cada parte en su línea, sin el punto medio (depende de la página
// de códigos). Solo local: no pasa por la cola, así que NO dispara el apagado de los equipos
// anteriores (eso sigue ocurriendo con el primer trabajo de la cola que imprima este equipo).
function renderVinculado(nombre, hora){
  let t = CMD.init + CMD.centro + 'LevoPrint\n' + CMD.negritaOn + CMD.grande + 'VINCULADO\n' + CMD.normal + CMD.negritaOff;
  t += linea('=');
  for (const parte of String(nombre || '').split(' · ').map((x) => x.trim()).filter(Boolean)) t += parte.slice(0, ANCHO) + '\n';
  if (hora) t += hora + '\n';
  t += linea('=') + 'Si lees esto, la impresora\nya funciona.\n';
  t += '\x1b\x21\x00' + pieMarca(APPS_PIE[String(PREFIJO || '').toLowerCase()] || '', ANCHO) + CMD.corte;
  return t;
}
function horaLocal(){
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// Imprime el papel de vinculado en la estación del código (por nombre) o, si no, en la primera
// con IP. Devuelve { ok, mensaje } para la ventana; nunca lanza (el vínculo ya quedó hecho).
// [LP-U1] v = el vínculo recién hecho (cada app tiene sus propias estaciones).
async function imprimirVinculado(v, nombre){
  try {
    try { await refrescarConfig(v); } catch (_) { /* sin estaciones: se avisa abajo */ }
    const deCodigo = String(nombre || '').split(' · ')[0].trim().toLowerCase();
    // [QA MEDIO-1] Sin adivinar: [LP-F3] la estación del vínculo (estacionVinculo) o la del nombre del
    // código si tiene impresora que este equipo alcance (red o USB de esta PC); si no, la ÚNICA así.
    // Con varias o ninguna, la ventana pregunta «¿Dónde está la impresora de <estación>?».
    const dests = [...v.estaciones.keys()].map((id) => destinoDe(v, id)).filter(Boolean);
    const imprimibles = dests.filter(destinoImprimible);
    const est = imprimibles.find((d) => d.estacion === v.estacionVinculo)
      || imprimibles.find((d) => String(d.nombre || '').trim().toLowerCase() === deCodigo)
      || (imprimibles.length === 1 && !v.estacionVinculo ? imprimibles[0] : null);
    const texto = conPrefijo(v.prefijo, () => renderVinculado(nombre, horaLocal()));
    if (MODO_CONSOLA || !est) {
      console.log('[vinculado] ' + paraConsola(texto, ' '));
      if (MODO_CONSOLA) return { ok: true, mensaje: 'Modo consola: el papel de prueba se mostró en la consola.' };
      v.preguntar = true;
      return { ok: false, mensaje: v.transporte === false
        ? (imprimibles.length
          ? 'No salió el papel de prueba: hay varias impresoras y no se sabe cuál es la de esta estación. Revisa el nombre de la estación en ' + consolaDe(v.prefijo) + '.'
          : 'No salió el papel de prueba: falta la IP de la impresora en ' + consolaDe(v.prefijo) + '.')
        : 'Falta elegir la impresora: abajo te mostramos las que encontramos.' };
    }
    await imprimirDestino(est, texto);
    console.log('[vinculado] papel de prueba -> ' + est.nombre + ' (' + textoDestino(est) + ')');
    return { ok: true, mensaje: 'Salió un papel de prueba en ' + est.nombre + ': la impresora ya funciona.' };
  } catch (e) {
    console.error('[vinculado] no salio el papel de prueba: ' + e.message);
    v.preguntar = true;
    return { ok: false, mensaje: 'No salió el papel de prueba: revisa que la impresora esté encendida y conectada.' };
  }
}

function firma(pl){
  const app=APPS_PIE[String(PREFIJO||'').toLowerCase()]||(pl&&pl.app)||process.env.LEVO_APP||"";
  return CMD.centro+"\x1b\x21\x00"+pieMarca(app, ANCHO, CON_IMAGEN&&!(pl&&pl.sinImagen));
}

// Copia de un papel que SI salio: sello arriba (cocina no lo toma por pedido nuevo).
function render(job) {
  const t = renderBase(job);
  const pl = job.payload || {};
  if ((!pl.reimpresion && !pl.atrasada) || !t.startsWith(CMD.init)) return t;
  let sello = CMD.centro;
  // [kuti] KUTI marca toda reimpresion con "copia": el sello dice COPIA.
  if (pl.copia) return CMD.init + sello + CMD.negritaOn + CMD.grande + '*** COPIA ***\n' + CMD.normal + CMD.negritaOff + CMD.izq + t.slice(CMD.init.length);
  if (pl.atrasada) sello += CMD.negritaOn + CMD.grande + '*** ATRASADA ***\n' + CMD.normal + 'Pedido de las ' + (pl.hora || '?') + '\n' + CMD.negritaOff;
  if (pl.reimpresion) sello += CMD.negritaOn + '*** REIMPRESION ***\n' + CMD.negritaOff;
  return CMD.init + sello + CMD.izq + t.slice(CMD.init.length);
}

function renderCierre(pl) {
  let t = CMD.init + CMD.centro;
  if (pl.negocio) t += CMD.negritaOn + String(pl.negocio).toUpperCase() + '\n' + CMD.negritaOff;
  t += CMD.grande + 'CORTE DE CAJA\n' + CMD.normal + CMD.izq + linea('=');
  for (const l of pl.lineas) {
    if (l && l.sep) { t += linea(String(l.sep).slice(0, 1) || '-'); continue; }
    const der = String((l && l.der) || '');
    const f = fila(String((l && l.izq) || '').slice(0, Math.max(1, ANCHO - der.length - 1)), der);
    t += l && l.negrita ? CMD.negritaOn + f + CMD.negritaOff : f;
  }
  t += linea('=') + CMD.centro + firma(pl) + CMD.corte;
  return t;
}

// [O-23 · 04-nov] Ticket del cliente SIN CITA de KUTI (tipo TURNO). Mismo papel que kuti-print
// (render.ts) y que el APK (Agent.kt): negocio, local, «TURNO SIN CITA», el número de la cola
// (definitivo) o el provisional del equipo (sin red) en triple alto, nombre, con quién, hora y las
// notas de la hoja de KUTI en ASCII PURO (la página de códigos de la térmica varía), partidas por
// palabra al ancho. Payload: negocio, local, definitivo, numero, provisional, nombre, con, fecha,
// delante (n.º o null).
function envolver(texto, ancho) {
  ancho = Math.max(1, ancho);
  const out = [];
  let l = '';
  for (let w of String(texto == null ? '' : texto).split(/\s+/).filter(Boolean)) {
    while (w.length > ancho) { if (l) { out.push(l); l = ''; } out.push(w.slice(0, ancho)); w = w.slice(ancho); }
    if (!w) continue;
    if (!l) l = w;
    else if (l.length + 1 + w.length <= ancho) l += ' ' + w;
    else { out.push(l); l = w; }
  }
  if (l) out.push(l);
  return out;
}
function numeroTurno(pl) {
  const v = pl.definitivo ? pl.numero : (pl.provisional || pl.numero);
  return String(v == null ? '' : v).replace(/[^\x21-\x7e]/g, '').slice(0, Math.max(1, Math.floor(ANCHO / 3)));
}
function notasTurno(pl) {
  const n = [];
  if (pl.definitivo) {
    const d = pl.delante == null || pl.delante === '' ? NaN : Number(pl.delante);
    if (d === 0) n.push('Es el siguiente en la cola.');
    else if (d === 1) n.push('Hay 1 persona delante.');
    else if (Number.isFinite(d) && d > 1) n.push('Hay ' + Math.floor(d) + ' personas delante.');
    n.push('Mira la pantalla de la sala: ahi sale tu numero cuando te toque.');
  } else {
    n.push('Numero provisional: se tomo sin internet.');
    n.push('Cuando vuelva la red recibes tu numero de la cola. En la pantalla de la sala lo veras junto a este, por ejemplo:');
    n.push('15 - ' + numeroTurno(pl) + ' (el 15 es un ejemplo)');
    n.push('No pierdes tu lugar: la cola va por la hora en que llegaste.');
  }
  return n;
}
function renderTurno(pl) {
  pl = pl || {};
  let t = CMD.init + CMD.centro;
  const neg = String(pl.negocio || ''), loc = String(pl.local || '');
  // [QA M2] el negocio va en doble ancho, partido en varios renglones (nunca se corta)
  if (neg) t += negocioGrande(neg);
  if (loc && loc !== neg) t += loc + '\n';
  t += CMD.negritaOn + 'TURNO SIN CITA\n' + CMD.negritaOff + linea('=');
  t += (pl.definitivo ? 'Tu numero' : 'Tu numero provisional') + '\n';
  t += CMD.negritaOn + CMD.enorme + numeroTurno(pl) + '\n' + CMD.normal + CMD.negritaOff;
  if (pl.nombre) t += String(pl.nombre).slice(0, ANCHO) + '\n';
  if (pl.con) t += ('Con ' + pl.con).slice(0, ANCHO) + '\n';
  if (pl.fecha || pl.hora) t += String(pl.fecha || pl.hora) + '\n';
  t += CMD.izq + linea();
  for (const nota of notasTurno(pl)) for (const l of envolver(nota, ANCHO)) t += l + '\n';
  t += linea('=') + firma(pl) + CMD.corte;
  return t;
}

function renderBase(job) {
  if (job.tipo === 'CARTA_QR') return renderCartaQr(job.payload);
  if (job.tipo === 'TURNO') return renderTurno(job.payload);
  if (job.tipo === 'COMANDA') return renderComanda(job.payload);
  if (job.tipo === 'PRECUENTA') return renderPrecuenta(job.payload);
  if (job.tipo === 'TICKET') return renderTicket(job.payload);
  if (job.tipo === 'CPE') return renderCpe(job.payload);
  // [kuti] Corte con lineas ya formateadas por la base (KOMO/KIPU: JSON como antes).
  if (job.tipo === 'CIERRE' && Array.isArray((job.payload || {}).lineas)) return renderCierre(job.payload);
  if (job.tipo === 'PRUEBA') return CMD.init + CMD.centro + 'PRUEBA LEVOPRINT OK\n' + firma(job.payload) + CMD.corte; // [MM3-01] la prueba lleva el pie: se ve si la impresora imprime el logo (si no, LEVO_IMAGEN=0)
  return CMD.init + JSON.stringify(job.payload, null, 1) + CMD.corte;
}

function imprimirRaw(ip, puerto, datos) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port: puerto, timeout: 5000 });
    sock.on('connect', () => sock.end(Buffer.from(datos, 'binary'), resolve));
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`timeout ${ip}:${puerto}`)); });
    sock.on('error', reject);
  });
}

// ============================================================
// [LP-F3 · LP-F4] Impresora por estación: red, USB (cola de Windows) o Bluetooth
// (backend levoprint_transporte, docs/LEVOPRINT.md §8). Cada estación trae su
// destino en <prefijo>_agente_impresoras: { estacion, transporte, ip, puerto,
// btMac, usbId, impresoraNombre, propio }. «propio» = la impresora USB/BT está
// en ESTE equipo; si no, el trabajo no es nuestro (el servidor ya no nos lo da,
// pero si llega se marca IMPRESORA_EN_OTRO_EQUIPO). En Windows «USB» es una
// impresora instalada en la PC: se le manda el ESC/POS en RAW por la cola de
// impresión (winspool), así sirve también una BT emparejada como impresora.
// Sin las RPC nuevas (backend viejo) todo esto se apaga 30 min y el agente
// imprime como la 1.12: solo por la IP de la estación.
// ============================================================
// Solo en desarrollo (node index.js) se aceptan los ajustes de prueba: un
// levoprint.txt ajeno no puede cambiar a qué programa llama el .exe.
const AJUSTE_PRUEBA = (k) => (esExe ? '' : String(process.env[k] || '').trim());
const PUERTO_IMPRESORA = parseInt(AJUSTE_PRUEBA('LEVO_BUSCAR_PUERTO') || '9100', 10) || 9100;
const BUSCAR_CADA_MS = 15 * 60000;     // búsqueda sola cada 15 min
const INFORMAR_CADA_MS = 30 * 60000;   // la lista se reenvía igual cada 30 min aunque no cambie
const SIN_TRANSPORTE_MS = 30 * 60000;  // backend sin las RPC nuevas: modo 1.12 por 30 min
const MAX_ENCONTRADAS = 64;            // mismo tope que lp_impresoras_vistas
const SONDEO_MS = 400, SONDEO_PARALELO = 48;

// Error con código corto (va a print_marcar y a la ventana).
function errorCodigo(codigo, texto) {
  const e = new Error(codigo + ': ' + texto);
  e.codigoLp = codigo;
  return e;
}

// Candado por destino: dos trabajos (o el ciclo y un «Probar» de la ventana)
// no se mezclan en la misma impresora.
const candados = new Map();
function conCandado(clave, fn) {
  const previo = candados.get(clave) || Promise.resolve();
  const p = previo.then(fn);
  const fin = p.catch(() => {}).then(() => { if (candados.get(clave) === fin) candados.delete(clave); });
  candados.set(clave, fin);
  return p;
}

// --- Búsqueda en la red: hosts de las /24 propias con el :9100 abierto ---
function ipANum(ip) { return String(ip).split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0); }
function numAIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
// Interfaces IPv4 de esta PC (sin loopback ni 169.254 = sin DHCP). Máscara más
// ancha que /24 (p. ej. /16) se recorta a la /24 propia: 254 equipos en ~3 s.
// Como mucho 4 redes (Wi-Fi + cable + adaptadores virtuales).
function hostsDeSubredes(ifaces) {
  const out = [], redes = new Set(), propias = new Set();
  const M24 = ipANum('255.255.255.0');
  for (const i of ifaces || []) {
    if (!i || i.internal || !(i.family === 'IPv4' || i.family === 4)) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(i.address)) || /^169\.254\./.test(i.address)) continue;
    propias.add(i.address);
    let mascara = ipANum(i.netmask || '255.255.255.0');
    if (mascara < M24) mascara = M24;
    const red = (ipANum(i.address) & mascara) >>> 0;
    const difusion = (red | (~mascara >>> 0)) >>> 0;
    if (redes.has(red) || redes.size >= 4) continue;
    redes.add(red);
    for (let h = red + 1; h < difusion; h++) out.push(numAIp(h));
  }
  return out.filter((h) => !propias.has(h));
}
function interfacesParaBuscar() {
  // Prueba: LEVO_BUSCAR_SUBRED=127.0.0 recorre esa /24 (impresoras falsas en 127.0.0.x).
  const forzada = AJUSTE_PRUEBA('LEVO_BUSCAR_SUBRED');
  if (forzada) return [{ address: forzada + '.250', netmask: '255.255.255.0', family: 'IPv4', internal: false }];
  return Object.values(os.networkInterfaces() || {}).flat();
}
// connect + close, sin mandar ni un byte (no imprime nada ni despierta la impresora).
function sondear(ip, puerto, ms) {
  return new Promise((resolve) => {
    let listo = false;
    const fin = (v) => { if (listo) return; listo = true; try { s.destroy(); } catch { /* nada */ } resolve(v); };
    const s = net.createConnection({ host: ip, port: puerto });
    s.setTimeout(ms, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}
async function buscarRed() {
  const hosts = hostsDeSubredes(interfacesParaBuscar());
  const hallados = [];
  let i = 0;
  const trabajador = async () => { while (i < hosts.length) { const h = hosts[i++]; if (await sondear(h, PUERTO_IMPRESORA, SONDEO_MS)) hallados.push(h); } };
  await Promise.all(Array.from({ length: Math.min(SONDEO_PARALELO, hosts.length) }, trabajador));
  return hallados.sort((a, b) => ipANum(a) - ipANum(b)).map((ip) => ({
    transporte: 'red', ref: ip + ':' + PUERTO_IMPRESORA, nombre: 'Impresora en ' + ip, detalle: { puerto: PUERTO_IMPRESORA },
  }));
}

// --- USB en Windows: PowerShell hijo PERSISTENTE con winspool en RAW ---
// Se abre UNA vez (powershell.exe -NoProfile -NonInteractive -Command -), sin
// -EncodedCommand ni -ExecutionPolicy Bypass (los antivirus los miran feo). El
// C# va en la variable de entorno LP_CS; el script, en una sola línea por la
// entrada estándar. Protocolo: una línea JSON por pedido {id, op, ...} → una
// línea JSON por respuesta {id, ok, error?, impresoras?}. Primero responde
// {listo:true} (Add-Type compiló) o {listo:false, error:'POWERSHELL_RESTRINGIDO'}
// (Constrained Language / AppLocker): entonces no hay USB y se avisa en la
// ventana. Si el proceso cae, se vuelve a abrir en el siguiente pedido.
// Riesgo conocido: drivers v4 pueden rechazar RAW (sale el error de Windows).
const PS_CS = [
  'using System; using System.Runtime.InteropServices;',
  'public static class LpRaw {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public class DocInfo { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }',
  '  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);',
  '  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] static extern int StartDocPrinter(IntPtr h, int nivel, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo di);',
  '  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);',
  '  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int escritos);',
  '  public static string Enviar(string cola, byte[] datos) {',
  '    IntPtr h;',
  '    if (!OpenPrinter(cola, out h, IntPtr.Zero)) return "WIN32_" + Marshal.GetLastWin32Error();',
  '    try {',
  '      DocInfo di = new DocInfo(); di.pDocName = "LevoPrint"; di.pDataType = "RAW";',
  '      if (StartDocPrinter(h, 1, di) == 0) return "WIN32_" + Marshal.GetLastWin32Error();',
  '      try {',
  '        if (!StartPagePrinter(h)) return "WIN32_" + Marshal.GetLastWin32Error();',
  '        int escritos;',
  '        bool ok = WritePrinter(h, datos, datos.Length, out escritos);',
  '        int err = Marshal.GetLastWin32Error();',
  '        EndPagePrinter(h);',
  '        if (!ok) return "WIN32_" + err;',
  '        if (escritos != datos.Length) return "INCOMPLETO_" + escritos + "_" + datos.Length;',
  '        return "";',
  '      } finally { EndDocPrinter(h); }',
  '    } finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\n');
// Una sola línea (con -Command - cada línea completa se ejecuta al llegar).
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "function LpSale($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { LpSale @{ listo = $false; error = 'POWERSHELL_RESTRINGIDO'; detalle = [string]$ExecutionContext.SessionState.LanguageMode }; exit 3 }",
  "try { Add-Type -TypeDefinition $env:LP_CS -Language CSharp } catch { LpSale @{ listo = $false; error = 'POWERSHELL_RESTRINGIDO'; detalle = $_.Exception.Message }; exit 3 }",
  "function LpListar { try { @(Get-Printer | ForEach-Object { @{ nombre = [string]$_.Name; driver = [string]$_.DriverName; puerto = [string]$_.PortName } }) } catch { @(Get-CimInstance Win32_Printer | ForEach-Object { @{ nombre = [string]$_.Name; driver = [string]$_.DriverName; puerto = [string]$_.PortName } }) } }",
  'LpSale @{ listo = $true }',
  "while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }; if (-not $l.Trim()) { continue }; $r = @{ ok = $false }; try { $m = $l | ConvertFrom-Json; $r.id = $m.id; if ($m.op -eq 'listar') { $r.impresoras = @(LpListar); $r.ok = $true } elseif ($m.op -eq 'imprimir') { $e = [LpRaw]::Enviar([string]$m.cola, [Convert]::FromBase64String([string]$m.b64)); if ($e) { $r.error = $e } else { $r.ok = $true } } else { $r.error = 'OP_DESCONOCIDA' } } catch { $r.error = 'PS: ' + $_.Exception.Message }; LpSale $r }",
].join('; ');
const psWin = { proc: null, listo: null, pendientes: new Map(), sig: 1, estado: '', detalle: '' };
const PS_TIEMPO_MS = parseInt(AJUSTE_PRUEBA('LEVO_PRUEBA_PS_TIEMPO') || '20000', 10) || 20000;
function usbDisponible() { return process.platform === 'win32' || !!AJUSTE_PRUEBA('LEVO_PRUEBA_PS'); }
// JSON solo ASCII (lo demás como \uXXXX): la consola de PowerShell 5.1 no siempre lee UTF-8 por la entrada.
const jsonAscii = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function psCerrar(motivo) {
  const p = psWin.proc;
  psWin.proc = null; psWin.listo = null;
  if (p) { try { p.kill(); } catch { /* ya cerró */ } }
  for (const [, pend] of psWin.pendientes) { clearTimeout(pend.timer); pend.reject(errorCodigo(motivo, 'el proceso de impresión USB se reinició')); }
  psWin.pendientes.clear();
}
function psIniciar() {
  if (psWin.estado === 'restringido') return Promise.resolve(false);
  if (psWin.listo) return psWin.listo;
  psWin.listo = new Promise((resolve) => {
    let p;
    const doble = AJUSTE_PRUEBA('LEVO_PRUEBA_PS'); // prueba: un .cjs que imita a PowerShell
    try {
      p = doble
        ? spawn(process.execPath, [doble], { windowsHide: true, env: { ...process.env, LP_CS: PS_CS } })
        : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, env: { ...process.env, LP_CS: PS_CS } });
    } catch (e) { psWin.estado = 'no_disponible'; psWin.detalle = e.message; psWin.listo = null; return resolve(false); }
    psWin.proc = p;
    let buf = '', resuelto = false;
    const arranque = setTimeout(() => {
      if (resuelto) return;
      resuelto = true; psWin.estado = 'no_disponible'; psWin.detalle = 'PowerShell no respondió';
      psCerrar('USB_TIEMPO'); resolve(false);
    }, PS_TIEMPO_MS);
    p.on('error', (e) => {
      if (!resuelto) { resuelto = true; clearTimeout(arranque); psWin.estado = 'no_disponible'; psWin.detalle = e.message; psWin.listo = null; psWin.proc = null; resolve(false); }
    });
    p.on('exit', () => {
      if (psWin.proc !== p) return;
      psWin.proc = null; psWin.listo = null;
      for (const [, pend] of psWin.pendientes) { clearTimeout(pend.timer); pend.reject(errorCodigo('USB_PROCESO_CAYO', 'el proceso de impresión USB se cerró')); }
      psWin.pendientes.clear();
      if (!resuelto) { resuelto = true; clearTimeout(arranque); if (psWin.estado !== 'restringido') { psWin.estado = 'no_disponible'; psWin.detalle = psWin.detalle || 'PowerShell se cerró al iniciar'; } resolve(false); }
    });
    p.stdin.on('error', () => { /* EPIPE: el 'exit' lo resuelve */ });
    p.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.error('[usb] ' + t.slice(0, 300)); });
    p.stdout.on('data', (d) => {
      buf += String(d);
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const lineaPs = buf.slice(0, k).replace(/^﻿/, '').trim();
        buf = buf.slice(k + 1);
        if (!lineaPs.startsWith('{')) continue; // eco o avisos de PowerShell: se ignoran
        let m; try { m = JSON.parse(lineaPs); } catch { continue; }
        if (!resuelto && 'listo' in m) {
          resuelto = true; clearTimeout(arranque);
          if (m.listo === true) { psWin.estado = 'ok'; psWin.detalle = ''; resolve(true); }
          else { psWin.estado = 'restringido'; psWin.detalle = String(m.detalle || m.error || ''); console.error('[usb] POWERSHELL_RESTRINGIDO: ' + psWin.detalle.slice(0, 200)); resolve(false); }
          continue;
        }
        const pend = psWin.pendientes.get(m.id);
        if (!pend) continue;
        psWin.pendientes.delete(m.id); clearTimeout(pend.timer);
        pend.resolve(m);
      }
    });
    try { p.stdin.write(PS_SCRIPT + '\n'); } catch { /* el 'exit' lo resuelve */ }
  });
  return psWin.listo;
}
async function psPedir(obj) {
  if (!usbDisponible()) throw errorCodigo('USB_NO_DISPONIBLE', 'esta PC no tiene impresión USB');
  if (!(await psIniciar())) throw errorCodigo(psWin.estado === 'restringido' ? 'POWERSHELL_RESTRINGIDO' : 'USB_NO_DISPONIBLE', 'Windows no deja usar la impresión USB en esta PC (' + (psWin.detalle || psWin.estado) + ')');
  const p = psWin.proc;
  if (!p) throw errorCodigo('USB_PROCESO_CAYO', 'el proceso de impresión USB se cerró');
  return new Promise((resolve, reject) => {
    const id = psWin.sig++;
    const timer = setTimeout(() => {
      psWin.pendientes.delete(id);
      reject(errorCodigo('USB_TIEMPO', 'la impresora USB no respondió en ' + Math.round(PS_TIEMPO_MS / 1000) + ' s'));
      psCerrar('USB_TIEMPO'); // proceso trabado: se abre otro en el próximo pedido
    }, PS_TIEMPO_MS);
    psWin.pendientes.set(id, { resolve, reject, timer });
    try { p.stdin.write(jsonAscii({ id, ...obj }) + '\n'); } catch (e) { clearTimeout(timer); psWin.pendientes.delete(id); reject(errorCodigo('USB_PROCESO_CAYO', e.message)); }
  });
}
// Colas que no son impresoras de tickets: PDF, XPS, Fax, OneNote, «Enviar a…» y el puerto «preguntar».
const COLA_EXCLUIDA = /pdf|xps|fax|onenote|send to|enviar a|document writer/i;
const DRIVER_TERMICA = /pos|receipt|thermal|t[eé]rmic|tm-|tm ?t|xprinter|xp-|star |tsp|bixolon|srp|citizen|ct-s|sewoo|zj-?\d|gprinter|3nstar|hprt|rongta|sunmi|generic \/ text|gen[eé]ric|58 ?mm|80 ?mm/i;
function colaUsbValida(i) {
  return !!(i && i.nombre) && !COLA_EXCLUIDA.test(i.nombre + ' ' + (i.driver || '')) && !/^PORTPROMPT:/i.test(String(i.puerto || ''));
}
async function listarUsb() {
  const r = await psPedir({ op: 'listar' });
  if (!r || r.ok !== true) throw errorCodigo('USB_LISTA', String((r && r.error) || 'sin respuesta'));
  return (Array.isArray(r.impresoras) ? r.impresoras : []).filter(colaUsbValida).slice(0, 32).map((i) => ({
    transporte: 'usb', ref: String(i.nombre).slice(0, 128), nombre: String(i.nombre).slice(0, 80),
    detalle: { modelo: String(i.driver || '').slice(0, 80), puerto: String(i.puerto || '').slice(0, 60), probableTermica: DRIVER_TERMICA.test(String(i.driver || '') + ' ' + i.nombre) },
  }));
}
function mensajeUsb(err) {
  const m = String(err || '');
  if (/WIN32_1801\b/.test(m)) return 'no encuentro esa impresora en esta PC (¿la desinstalaron o cambió de nombre?)';
  if (/WIN32_5\b/.test(m)) return 'Windows no dio permiso para usar esa impresora';
  return m;
}
async function imprimirUsbWin(cola, datos) {
  const r = await psPedir({ op: 'imprimir', cola, b64: Buffer.from(datos, 'binary').toString('base64') });
  if (!r || r.ok !== true) throw errorCodigo('USB_ERROR', mensajeUsb(r && r.error));
}

// --- Destino de cada estación (agente_config + agente_impresoras) ---
function destinoDe(v, estId) {
  const est = v.estaciones.get(estId);
  const d = v.destinos && v.destinos.get(estId);
  if (d) {
    return {
      estacion: estId, nombre: d.nombre || (est && est.nombre) || '', transporte: d.transporte || 'red',
      ip: d.ip || null, puerto: parseInt(d.puerto, 10) || 9100, btMac: d.btMac || null, usbId: d.usbId || null,
      impresoraNombre: d.impresoraNombre || '', propio: d.propio !== false,
    };
  }
  if (!est) return null;
  return { estacion: estId, nombre: est.nombre || '', transporte: 'red', ip: est.ip || null, puerto: est.puerto || 9100, propio: true };
}
// ¿Este equipo puede imprimir ahí ahora? (red con IP, o USB que está en esta PC)
function destinoImprimible(d) {
  if (!d) return false;
  if (d.transporte === 'red') return !!d.ip;
  if (d.transporte === 'usb') return d.propio && !!d.usbId;
  return false;
}
function claveDestino(d) {
  return d.transporte === 'red' ? 'red:' + d.ip + ':' + (d.puerto || 9100) : d.transporte + ':' + (d.usbId || d.btMac || '');
}
function textoDestino(d) {
  if (!d) return 'Sin estación';
  if (d.transporte === 'usb') return (d.propio ? 'USB en esta PC: ' : 'USB en otro equipo: ') + (d.impresoraNombre || d.usbId || '');
  if (d.transporte === 'bluetooth') return 'Bluetooth en otro equipo' + (d.impresoraNombre ? ': ' + d.impresoraNombre : '');
  return d.ip ? 'Red: ' + d.ip + ':' + (d.puerto || 9100) : '';
}
async function imprimirDestino(d, texto) {
  if (!d) throw errorCodigo('SIN_ESTACION', 'el trabajo no trae una estación conocida');
  if (d.transporte === 'red') {
    if (!d.ip) throw errorCodigo('SIN_IP', 'estacion sin IP');
    return conCandado(claveDestino(d), () => imprimirRaw(d.ip, d.puerto || 9100, texto));
  }
  if (!d.propio) throw errorCodigo('IMPRESORA_EN_OTRO_EQUIPO', 'la impresora de ' + (d.nombre || 'esta estacion') + ' esta conectada a otro equipo');
  if (d.transporte === 'usb') {
    if (!d.usbId) throw errorCodigo('SIN_USB', 'estacion USB sin impresora');
    return conCandado(claveDestino(d), () => imprimirUsbWin(d.usbId, texto));
  }
  throw errorCodigo('TRANSPORTE_NO_SOPORTADO', 'esta PC no imprime por Bluetooth directo: instala la impresora en Windows y elígela como USB');
}

// --- Estado de la búsqueda (lo comparten todos los vínculos: es el mismo equipo) ---
const busqueda = { enCurso: null, ts: 0, red: [], usb: [], md5: '', usbAviso: '', motivo: '', pedidaTs: 0 };
function encontradasActuales() { return busqueda.red.concat(busqueda.usb).slice(0, MAX_ENCONTRADAS); }
function md5Lista(lista) {
  const orden = lista.map((x) => [x.transporte, x.ref, x.nombre]).sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
  return crypto.createHash('md5').update(JSON.stringify(orden)).digest('hex');
}
function capacidades() {
  const c = ['red'];
  if (usbDisponible() && psWin.estado !== 'restringido' && psWin.estado !== 'no_disponible') c.push('usb');
  return c;
}
const nombreEquipo = () => String(os.hostname() || 'PC').slice(0, 60);
function textoUsbAviso() {
  if (!usbDisponible()) return '';
  if (psWin.estado === 'restringido') return 'Windows bloquea la impresión USB en esta PC (PowerShell restringido por la empresa o el antivirus). Usa una impresora de red o pide a quien administra la PC que lo permita.';
  if (psWin.estado === 'no_disponible') return 'No se pudo revisar las impresoras USB de esta PC (' + (psWin.detalle || 'PowerShell no responde') + ').';
  return '';
}
// Busca en la red y en las impresoras de Windows a la vez; al terminar lo
// informa al instante a cada app (con «buscado») para que su consola lo vea.
function buscarImpresoras(motivo) {
  if (busqueda.enCurso) return busqueda.enCurso;
  busqueda.motivo = motivo || '';
  busqueda.enCurso = (async () => {
    const t0 = Date.now();
    const [red, usb] = await Promise.all([
      buscarRed().catch((e) => { console.error('[buscar] red: ' + e.message); return busqueda.red; }),
      usbDisponible() ? listarUsb().catch((e) => { console.error('[buscar] usb: ' + e.message); return []; }) : Promise.resolve([]),
    ]);
    busqueda.red = red; busqueda.usb = usb; busqueda.ts = Date.now();
    busqueda.usbAviso = textoUsbAviso();
    busqueda.md5 = md5Lista(encontradasActuales());
    console.log('[buscar] ' + (motivo || '') + ': ' + red.length + ' de red, ' + usb.length + ' USB (' + (Date.now() - t0) + ' ms)');
    for (const v of vinculos) v.buscadoPendiente = true;
    await Promise.all(vinculos.slice().map((v) => informarImpresoras(v, true).catch((e) => {
      if (!esAgenteInvalido(e)) console.error('[impresoras ' + v.prefijo + '] ' + e.message);
    })));
    return encontradasActuales();
  })().finally(() => { busqueda.enCurso = null; });
  return busqueda.enCurso;
}

// <prefijo>_agente_impresoras: cada ciclo de config (y tras cada búsqueda).
// La lista va solo si cambió (md5) o pasaron 30 min; «buscado» avisa que ya se
// buscó (la consola espera ese resultado). Responde los destinos por estación,
// la estación del vínculo y si la consola pidió buscar. RPC ausente → modo 1.12.
async function informarImpresoras(v, forzar) {
  if (v.sinTransporteHasta > Date.now()) return null;
  const p = { device: v.device, version: 'exe/' + VERSION_AGENTE, equipo: nombreEquipo(), capacidades: capacidades() };
  if (busqueda.ts && (forzar || busqueda.md5 !== v.md5Informado || Date.now() - v.informadoTs >= INFORMAR_CADA_MS)) p.encontradas = encontradasActuales();
  if (v.buscadoPendiente && busqueda.ts) p.buscado = true;
  let r;
  try {
    r = await rpc(`${v.prefijo}_agente_impresoras`, p);
  } catch (e) {
    if (esRpcAusente(e)) {
      if (v.transporte !== false) console.log(`[impresoras ${v.prefijo}] el servidor aun no tiene la impresora por estacion: sigo como la 1.12 (solo IP) por 30 min.`);
      v.transporte = false; v.sinTransporteHasta = Date.now() + SIN_TRANSPORTE_MS; v.destinos = new Map();
      return null;
    }
    throw e;
  }
  v.transporte = true; v.sinTransporteHasta = 0;
  // {ok:false, error:'PARAMETRO_INVALIDO'}: no se borra lo que ya se sabía de cada estación.
  if (!r || r.ok === false) { console.error(`[impresoras ${v.prefijo}] el servidor respondio ${(r && r.error) || 'vacio'}`); return null; }
  if (p.encontradas) { v.md5Informado = busqueda.md5; v.informadoTs = Date.now(); }
  if (p.buscado) v.buscadoPendiente = false;
  v.estacionVinculo = (r && r.estacionVinculo) || null;
  v.destinos = new Map(((r && r.destinos) || []).filter((d) => d && d.estacion).map((d) => [d.estacion, d]));
  // La consola pidió buscar (lp_buscar). Sin bucle: no si esta misma llamada ya llevaba «buscado»
  // y como mucho una búsqueda pedida por minuto.
  if (r && r.buscar && !p.buscado && !busqueda.enCurso && Date.now() - busqueda.pedidaTs > 60000) {
    busqueda.pedidaTs = Date.now();
    setTimeout(() => buscarImpresoras('pedido de la consola').catch(() => {}), 0);
  }
  return r;
}

// <prefijo>_agente_estacion_elegir desde la ventana (tras «¿Salió?» → Sí).
const ERRORES_ELEGIR = {
  ESTACION_NO_EXISTE: 'Esa estación ya no existe en tu app. Actualiza la página de tu app y vuelve a intentar.',
  PARAMETRO_INVALIDO: 'Los datos de la impresora no son válidos. Busca de nuevo y vuelve a intentar.',
  DESTINO_NO_VISTO: 'Tu app aún no ve esa impresora. Pulsa «Buscar de nuevo» y vuelve a elegirla.',
  EQUIPO_OTRO_LOCAL: 'Esta PC es de otro local que esa estación: elige su impresora desde un equipo de ese local.',
  AGENTE_INVALIDO: 'Este equipo está desactivado en tu app: vincúlalo de nuevo con un código.',
};
async function elegirDestino(v, estacion, transporte, ref, nombre) {
  const cuerpo = { device: v.device, estacion, transporte, nombre: String(nombre || '').slice(0, 80) };
  if (transporte === 'red') {
    const m = String(ref).match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
    if (!m) return { ok: false, error: 'PARAMETRO_INVALIDO', mensaje: ERRORES_ELEGIR.PARAMETRO_INVALIDO };
    cuerpo.ip = m[1]; cuerpo.puerto = parseInt(m[2] || '9100', 10);
  } else if (transporte === 'usb') {
    cuerpo.usbId = String(ref).slice(0, 128);
    // Que el servidor la tenga en lo visto por este equipo (si no, DESTINO_NO_VISTO).
    try { await informarImpresoras(v, true); } catch (_) { /* el elegir dirá lo que falte */ }
  }
  let r;
  try { r = await rpc(`${v.prefijo}_agente_estacion_elegir`, cuerpo); }
  catch (e) {
    if (esRpcAusente(e)) { v.transporte = false; v.sinTransporteHasta = Date.now() + SIN_TRANSPORTE_MS; return { ok: false, modo112: true }; }
    const cod = ERRORES_ELEGIR[e.pg] ? e.pg : '';
    return { ok: false, error: cod || 'RED', mensaje: ERRORES_ELEGIR[cod] || 'No se pudo guardar (revisa tu internet): ' + e.message };
  }
  if (!r || r.ok !== true) {
    const cod = String((r && r.error) || 'ERROR');
    return { ok: false, error: cod, mensaje: ERRORES_ELEGIR[cod] || 'No se pudo guardar (' + cod + ').' };
  }
  try { await refrescarConfig(v); } catch (_) { /* el ciclo lo vuelve a leer */ }
  return { ok: true, destino: r.destino || null };
}

// --- KOMO Agente (el programa antiguo de KOMO) ---
// LevoPrint 1.13 lee también komo-agente.txt (misma carpeta): si trae
// KOMO_DEVICE y aún no hay vínculo de KOMO, lo adopta (mismo token, sin
// código). Si komo-agente.exe sigue abierto o está en el arranque de Windows
// («KOMO Agente.lnk»), la ventana ofrece cerrarlo y quitarlo: si no, los dos
// toman la misma cola. Solo se ofrece con un vínculo de KOMO ya hecho aquí.
const KOMO_LNK = 'KOMO Agente.lnk';
const komoAgente = { abierto: false, enInicio: false, adoptado: false, revisado: 0 };
function rutaKomoLnk() { const c = carpetaInicio(); return c ? path.join(c, KOMO_LNK) : null; }
function adoptarKomoAgente() {
  const ruta = path.join(BASE_DIR, 'komo-agente.txt');
  if (!fs.existsSync(ruta) || vinculos.some((v) => v.prefijo === 'komo')) return false;
  let dev = '', url = '';
  try {
    for (const l of fs.readFileSync(ruta, 'utf8').replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
      const m = l.match(/^\s*(KOMO_DEVICE|KOMO_URL)\s*=\s*(.+?)\s*$/);
      if (m && m[1] === 'KOMO_DEVICE') dev = m[2];
      if (m && m[1] === 'KOMO_URL') url = m[2];
    }
  } catch { return false; }
  // Otro proyecto (URL distinta a la de LevoPrint): no se adopta (el token no serviría aquí).
  if (!esDeviceValido(dev) || (url && !/TU-PROYECTO/.test(url) && url.replace(/\/+$/, '') !== URL_BASE.replace(/\/+$/, ''))) return false;
  vinculos.push(nuevoVinculo('komo', dev, ''));
  if (vinculos.length === 1) PREFIJO = 'komo';
  komoAgente.adoptado = true;
  persistirVinculos(false);
  console.log('[komo-agente] vinculo de KOMO tomado de komo-agente.txt.');
  return true;
}
function revisarKomoAgente(forzar) {
  if (!forzar && Date.now() - komoAgente.revisado < 30000) return;
  komoAgente.revisado = Date.now();
  try { const r = rutaKomoLnk(); komoAgente.enInicio = !!r && fs.existsSync(r); } catch { komoAgente.enInicio = false; }
  if (process.platform !== 'win32') { komoAgente.abierto = false; return; }
  execFile('tasklist', ['/FI', 'IMAGENAME eq komo-agente.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, out) => {
    komoAgente.abierto = !err && /komo-agente\.exe/i.test(String(out || ''));
  });
}
function retirarKomoAgente() {
  return new Promise((resolve) => {
    if (!vinculos.some((v) => v.prefijo === 'komo')) {
      return resolve({ ok: false, error: 'KOMO_SIN_VINCULO', mensaje: 'Primero vincula KOMO en LevoPrint (escribe el código de KOMO arriba). Si cierras KOMO Agente antes, KOMO deja de imprimir.' });
    }
    let quitado = true;
    try { const r = rutaKomoLnk(); if (r && fs.existsSync(r)) fs.unlinkSync(r); } catch (e) { quitado = false; console.error('[komo-agente] no se pudo quitar el acceso: ' + e.message); }
    const fin = (cerrado) => {
      revisarKomoAgente(true);
      console.log('[komo-agente] retirado (cerrado=' + cerrado + ', acceso quitado=' + quitado + ').');
      resolve(cerrado && quitado
        ? { ok: true, mensaje: 'Listo: KOMO Agente se cerró y ya no se abrirá al encender la PC. LevoPrint imprime lo de KOMO.' }
        : { ok: false, error: 'KOMO_NO_SE_PUDO', mensaje: 'No se pudo cerrar KOMO Agente del todo. Ciérralo a mano (su ventana negra) y borra «KOMO Agente» de la carpeta Inicio.' });
    };
    if (process.platform !== 'win32') return fin(true);
    // /T cierra también su consola; «no se encontró» (código 128) cuenta como cerrado.
    execFile('taskkill', ['/IM', 'komo-agente.exe', '/F', '/T'], { windowsHide: true, timeout: 15000 }, (err) => fin(!err || err.code === 128));
  });
}

// Render SERVIDOR: el ticket se arma en la edge function `<prefijo>-print`
// y aquí solo se imprime. Así los cambios de formato/firma se despliegan
// sin re-instalar el agente. Si el endpoint falla, cae al render local.
// [qa5] pfx = prefijo capturado por la vuelta del ciclo (igual que las RPC).
async function renderRemoto(job, pfx) {
  const r = await fetch(`${URL_BASE}/functions/v1/${pfx || PREFIJO}-print`, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: job.tipo, payload: job.payload, ancho: ANCHO, imagen: CON_IMAGEN }),
  });
  if (!r.ok) throw new Error('render remoto HTTP ' + r.status);
  const j = await r.json();
  if (!j || j.ok !== true || !j.esc) throw new Error('render remoto sin esc');
  return Buffer.from(j.esc, 'base64').toString('binary');
}

/// --- ciclo principal ---
// [LP-U1] UN solo bucle atiende TODOS los vínculos (una app tras otra en cada
// vuelta). Cada vínculo lleva su token, sus estaciones, su relectura de config
// y su estado de desactivado; si una app falla, las demás siguen imprimiendo.
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
// [LP-U1] El backoff es POR vínculo (v.proximoIntento): una app desactivada no
// frena a las otras.
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
// (El desactivado y la última sincronización ahora van en cada vínculo.)
const guiEstado = {
  imprimiendo: false,       // true mientras se procesa un job ahora mismo
  ultimoError: null,        // { mensaje, ts } del ultimo job o ciclo fallido
  ultimoOk: null,           // ts del ultimo job impreso ok
};

// Render local con el prefijo del vínculo (pie de marca de SU app).
function conPrefijo(pfx, fn) {
  const antes = PREFIJO;
  PREFIJO = pfx || antes;
  try { return fn(); } finally { PREFIJO = antes; }
}

async function refrescarConfig(v) {
  const dev = v.device;
  const cfg = await rpc(`${v.prefijo}_agente_config`, { device: dev, version: 'exe/' + VERSION_AGENTE });
  v.estaciones = new Map((cfg.estaciones || []).map((e) => [e.id, e]));
  v.ultimaSync = Date.now();
  v.cicloConfig = Date.now();
  // [LP-F3] Luego el destino por estación (red / USB / Bluetooth). agente_config se sigue llamando
  // primero (KUTI guarda ahí la versión); un fallo aquí no frena la impresión por IP.
  try { await informarImpresoras(v, false); }
  catch (e) { if (esAgenteInvalido(e)) throw e; console.error(`[impresoras ${v.prefijo}] ${e.message}`); }
  console.log(`[cfg ${v.prefijo}] ${v.estaciones.size} estaciones:`,
    [...v.estaciones.keys()].map((id) => { const d = destinoDe(v, id); return `${d.nombre}@${textoDestino(d) || 'SIN-IMPRESORA'}`; }).join(' · '));
}

// Una vuelta de UN vínculo. Devuelve cuántos trabajos atendió.
// Token y prefijo son los del objeto v: si a media vuelta se canjea un código
// nuevo de la misma app, el vínculo NUEVO es otro objeto, los trabajos ya
// tomados se marcan con el token que los tomó y un AGENTE_INVALIDO del token
// viejo no pisa el estado del nuevo.
async function cicloVinculo(v) {
  const dev = v.device, pfx = v.prefijo;
  const vigente = () => vinculos.includes(v);
  try {
    if (Date.now() - v.cicloConfig >= CONFIG_CADA_MS) await refrescarConfig(v);
    const r = await rpc(`${pfx}_print_tomar`, { device: dev, limite: 10 });
    if (v.desactivado && vigente()) {
      console.log(`[agente ${pfx}] el servidor volvio a aceptar este equipo: retomo la impresion.`);
      v.desactivado = null;
      v.proximoIntento = 0;
    }
    const jobs = r.jobs || [];
    for (const job of jobs) {
      // [LP-F3] Destino según el transporte de la estación (red o USB de esta PC).
      const dest = destinoDe(v, job.estacion);
      guiEstado.imprimiendo = true;
      try {
        // Render en el SERVIDOR (formato siempre al día); respaldo local si cae.
        let texto;
        try { texto = await renderRemoto(job, pfx); }
        catch (_) { texto = conPrefijo(pfx, () => render(job)); }
        if (MODO_CONSOLA || !destinoImprimible(dest)) {
          console.log(`\n--- JOB ${pfx} ${job.id} (${job.tipo}) -> ${dest ? dest.nombre : 'SIN ESTACION'} ---`);
          console.log(paraConsola(texto));
          if (!MODO_CONSOLA) await imprimirDestino(dest, texto); // no imprimible: lanza el error que corresponde
        } else {
          await imprimirDestino(dest, texto);
          console.log(`[ok] ${pfx} job ${job.id} ${job.tipo} -> ${dest.nombre} (${textoDestino(dest)})`);
        }
        await rpc(`${pfx}_print_marcar`, { device: dev, id: job.id, ok: true });
        guiEstado.ultimoOk = Date.now();
      } catch (e) {
        console.error(`[err] ${pfx} job ${job.id}: ${e.message}`);
        guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
        try { await rpc(`${pfx}_print_marcar`, { device: dev, id: job.id, ok: false, error: e.message }); }
        catch (_) { /* sin red: el trabajo vuelve a la cola por el servidor */ }
      } finally {
        guiEstado.imprimiendo = false;
      }
    }
    return jobs.length;
  } catch (e) {
    if (esAgenteInvalido(e)) {
      // [qa4] Desactivado o reemplazado en la consola. NO se olvida el token
      // (el dueno puede reactivarlo): se pausa ESTE vínculo con backoff. La
      // mini-GUI muestra el aviso y acepta un codigo nuevo.
      if (vigente()) {
        if (!v.desactivado) {
          console.error(`[agente ${pfx}] ` + msgDesactivado(pfx));
          v.desactivado = { prefijo: pfx, desde: Date.now(), ts: Date.now() };
        }
        v.desactivado.ts = Date.now(); // ultimo intento
        v.proximoIntento = Date.now() + esperaDesactivado(v.desactivado.desde);
        v.cicloConfig = 0; // al volver, lo primero es releer estaciones
      }
    } else {
      console.error(`[ciclo ${pfx}]`, e.message);
      guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
    }
    return 0;
  }
}

async function ciclo() {
  cicloTimer = null;
  cicloEnCurso = true;
  let hubo = 0;
  try {
    for (const v of vinculos.slice()) {
      if (v.desactivado && Date.now() < v.proximoIntento) continue;
      hubo += await cicloVinculo(v);
    }
  } finally {
    // Espera progresiva: con trabajos vuelve a 2 s; vacío, suma 1 s hasta 6 s.
    // (Antes 2 s fijos, las 24 h: 43 mil consultas al día por local.)
    espera = hubo ? INTERVALO_MS : Math.min(INTERVALO_MAX_MS, espera + 1000);
    // Si TODOS están desactivados, se duerme hasta el próximo reintento.
    let prox = espera;
    if (vinculos.length && vinculos.every((v) => v.desactivado)) {
      prox = Math.max(INTERVALO_MS, Math.min(...vinculos.map((v) => v.proximoIntento)) - Date.now());
    }
    cicloEnCurso = false;
    if (vinculos.length) cicloTimer = setTimeout(ciclo, prox);
  }
}

// Adelanta la proxima vuelta (tras un canje o al abrir la ventana). Con
// reintentar=true también corta la pausa de los vínculos desactivados. Si hay
// una vuelta en curso, su finally ya programa la siguiente con la espera corta.
function despertarCiclo(reintentar) {
  espera = INTERVALO_MS;
  if (reintentar) for (const v of vinculos) v.proximoIntento = 0;
  if (cicloEnCurso) return;
  if (cicloTimer) { clearTimeout(cicloTimer); cicloTimer = null; }
  ciclo();
}

// [qa4] Edita levoprint.txt sin romper el BOM: el Bloc de notas puede dejar
// un BOM UTF-8 al inicio y, si LEVO_DEVICE esta en la PRIMERA linea, el
// regex ^LEVO_DEVICE no la veia (y se agregaba un segundo LEVO_DEVICE que al
// releer perdia contra el primero). Se quita el BOM, se edita y se repone.
function editarTxt(fn) {
  const ruta = RUTA_TXT; // [LP-U1] junto al .exe o, si ahí no se puede escribir, en %LOCALAPPDATA%\LevoPrint
  const crudo = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
  const bom = crudo.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  const txt = bom ? crudo.slice(1) : crudo;
  const nuevo = fn(txt);
  if (nuevo !== txt) fs.writeFileSync(ruta, bom + nuevo, 'utf8');
}
// Reemplaza CLAVE=... (primera aparicion) o la agrega al final.
function ponerClave(txt, clave, valor) {
  const re = new RegExp('^[ \\t]*' + clave + '[ \\t]*=.*$', 'im');
  // [QA LP-U1 · MEDIO 3] Reemplazo por función: un valor con «$&», «$1»… (nombre del negocio,
  // ruta del .exe) se escribe tal cual en vez de interpretarse como patrón.
  if (re.test(txt)) return txt.replace(re, () => clave + '=' + valor);
  return txt + (txt.endsWith('\n') || txt === '' ? '' : '\r\n') + clave + '=' + valor + '\r\n';
}

// [LP-U1] Guarda la lista de vínculos (LEVO_VINCULOS). El PRIMERO también
// queda como LEVO_DEVICE/LEVO_PREFIJO: si alguien vuelve a abrir un .exe
// anterior (1.11 o menos), sigue imprimiendo al menos esa app.
// usado = true tras un canje: comenta LEVO_CODIGO (el canje es de un uso).
function textoVinculos() {
  return vinculos.map((v) => v.prefijo + ':' + v.device + (v.nombre ? ':' + encodeURIComponent(v.nombre) : '')).join(',');
}
function persistirVinculos(usado, extra) {
  try {
    editarTxt((txt) => {
      if (usado) txt = txt.replace(/^[ \t]*LEVO_CODIGO[ \t]*=.*$/gim, '# LEVO_CODIGO usado');
      txt = ponerClave(txt, 'LEVO_VINCULOS', textoVinculos());
      if (vinculos[0]) {
        txt = ponerClave(txt, 'LEVO_DEVICE', vinculos[0].device);
        txt = ponerClave(txt, 'LEVO_PREFIJO', vinculos[0].prefijo);
      }
      return extra ? extra(txt) : txt;
    });
    return true;
  } catch (_) { return false; /* carpeta de solo lectura: queda en memoria esta sesion */ }
}
// Config vieja de un solo vínculo (LEVO_DEVICE + LEVO_PREFIJO): se pasa a
// LEVO_VINCULOS una vez, al arrancar. No borra las claves viejas.
function migrarConfigVieja() {
  if (String(process.env.LEVO_VINCULOS || '').trim() || !vinculos.length) return;
  if (persistirVinculos(false)) console.log('[cfg] config de un solo vinculo migrada a LEVO_VINCULOS.');
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
  // [LP-U1] Ya no se rechaza «ya vinculado»: un código de OTRA app agrega un
  // vínculo; uno de la MISMA app reemplaza al de esa app (re-vincular, o
  // equipo desactivado). El token viejo se cambia recién si el canje sale bien.
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
  console.log('Vinculando con el codigo ' + cod + ' (' + prefijoCod + ')...');
  let d;
  try {
    d = await rpc(`${prefijoCod}_estacion_codigo_canjear`, { codigo: cod });
  } catch (e) {
    console.error('No se pudo vincular (revisa tu internet): ' + e.message);
    return { ok: false, error: 'RED', mensaje: 'No se pudo vincular (revisa tu internet): ' + e.message };
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
  // El prefijo del bundle manda; si no viene, el de la letra. Se guarda en el
  // .txt (LEVO_VINCULOS) para que al reabrir el ciclo llame al proyecto correcto.
  // [LP-U1] Vínculo NUEVO (otro objeto): la vuelta en curso termina con el viejo.
  const v = nuevoVinculo(String(d.prefijo || prefijoCod).trim(), d.device, d.nombre || '');
  const i = vinculos.findIndex((x) => x.prefijo === v.prefijo);
  if (i >= 0) vinculos[i] = v; else vinculos.push(v);
  if (vinculos.length === 1) PREFIJO = v.prefijo;
  if (d.seccion) seccionVista[v.prefijo] = String(d.seccion).trim();
  // [QA LP-U1 · MEDIO 5] Si no se pudo escribir el .txt, el vínculo vale solo hasta cerrar: se avisa claro.
  const guardado = persistirVinculos(true);
  if (!guardado) console.error('[cfg] no se pudo guardar levoprint.txt en ' + DIR_TXT + ': el vinculo vale solo hasta cerrar LevoPrint.');
  guiEstado.ultimoError = null;
  // modo/reemplazara (rev 4): el servidor apaga a los anteriores recien con
  // el PRIMER trabajo IMPRESO de este agente; hasta entonces los dos imprimen.
  // (reemplazados = los que ya se apagaron: vale 0 en el canje.)
  const n = parseInt(d.reemplazara, 10) || 0;
  const aviso = (d.modo === 'reemplazar' && n === 1) ? 'Cuando imprimas tu primera comanda, se apagará el equipo anterior.'
    : (d.modo === 'reemplazar' && n > 1) ? `Cuando imprimas tu primera comanda, se apagarán los ${n} equipos anteriores.`
    : d.modo === 'adicional' ? 'Quedó como equipo adicional.' : '';
  const avisoGuardado = guardado ? '' : 'Vinculado solo hasta cerrar LevoPrint: no se pudo guardar la configuración (revisa permisos de la carpeta).';
  const avisoTotal = [aviso, avisoGuardado].filter(Boolean).join(' ');
  console.log('Vinculado como: ' + (d.nombre || 'estacion') + '. Listo.' + (aviso ? ' ' + aviso : '') + (d.reintento ? ' (reintento)' : ''));
  // vinculo: no enumerable (lleva un Map): no sale en el JSON de /vincular.
  const res = { ok: true, nombre: d.nombre, prefijo: v.prefijo, app: APP_POR_PREFIJO[v.prefijo] || v.prefijo.toUpperCase(),
    modo: d.modo || null, reemplazara: n, reintento: !!d.reintento, aviso: avisoTotal, guardado };
  Object.defineProperty(res, 'vinculo', { value: v, enumerable: false });
  return res;
}

// Persiste LEVO_ANCHO en levoprint.txt (mismo patron que LEVO_DEVICE arriba).
// [MM3-01 · MM3-P1] Persiste LEVO_IMAGEN (1 = pie con isotipo, 0 = solo texto).
function persistirImagen(valor) {
  try { editarTxt((txt) => ponerClave(txt, 'LEVO_IMAGEN', valor)); return true; } catch (_) { return false; }
}
function persistirAncho(valor) {
  try {
    editarTxt((txt) => ponerClave(txt, 'LEVO_ANCHO', valor));
    return true;
  } catch (_) { return false; /* carpeta de solo lectura: queda en memoria esta sesion */ }
}

// ============================================================
// [LP-U1] Arranque automático con Windows (sin permisos de administrador y
// sin .bat aparte; reemplaza instalar-inicio.bat / quitar-inicio.bat del
// agente de KOMO). Al vincular con éxito se crea «LevoPrint.lnk» en la
// carpeta Inicio DEL USUARIO (%APPDATA%\Microsoft\Windows\Start Menu\
// Programs\Startup) apuntando a ESTE .exe con «--inicio»: al encender la PC
// arranca minimizado y sin abrir el navegador. El botón «Quitar» de la
// ventana borra el acceso y deja LEVO_INICIO=0 para no volver a crearlo solo.
// LEVO_INICIO_EXE recuerda a qué .exe apunta: si el programa se movió de
// carpeta, al abrirlo a mano se corrige el acceso.
// ============================================================
const NOMBRE_LNK = 'LevoPrint.lnk';
function carpetaInicio() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function rutaLnk() { const c = carpetaInicio(); return c ? path.join(c, NOMBRE_LNK) : null; }
function inicioActivo() { const r = rutaLnk(); try { return !!r && fs.existsSync(r); } catch { return false; } }
// Solo el .exe empaquetado: en desarrollo (node index.js) el acceso apuntaría a node.exe.
const inicioDisponible = () => esExe && !!carpetaInicio();

function crearAccesoInicio() {
  return new Promise((resolve) => {
    if (!inicioDisponible()) return resolve({ ok: false, mensaje: 'El arranque automático solo existe en LevoPrint.exe para Windows.' });
    try { fs.mkdirSync(carpetaInicio(), { recursive: true }); } catch { /* ya existe */ }
    // Las rutas viajan por variables de entorno, NO dentro del comando: una
    // carpeta con comillas, «$» o tildes no rompe nada. Sin -ExecutionPolicy
    // Bypass (no hace falta con -Command y los antivirus lo miran feo).
    const ps = '$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut($env:LP_LNK); '
      + '$s.TargetPath = $env:LP_EXE; $s.Arguments = \'--inicio\'; $s.WorkingDirectory = $env:LP_DIR; '
      + '$s.WindowStyle = 7; $s.Description = \'LevoPrint - impresion de KOMO, KIPU y KUTI\'; $s.Save()';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: 20000,
      env: { ...process.env, LP_LNK: rutaLnk(), LP_EXE: process.execPath, LP_DIR: path.dirname(process.execPath) },
    }, (err) => {
      if (err || !inicioActivo()) {
        console.error('[inicio] no se pudo crear el acceso directo de inicio: ' + (err ? err.message : 'no aparecio el archivo'));
        return resolve({ ok: false, mensaje: 'No se pudo activar el arranque automático. Puedes abrir LevoPrint a mano al encender la PC.' });
      }
      try { editarTxt((txt) => ponerClave(ponerClave(txt, 'LEVO_INICIO', '1'), 'LEVO_INICIO_EXE', process.execPath)); } catch (_) { /* solo lectura */ }
      process.env.LEVO_INICIO = '1';
      process.env.LEVO_INICIO_EXE = process.execPath;
      console.log('[inicio] LevoPrint arrancara solo al encender la PC (' + rutaLnk() + ').');
      resolve({ ok: true, mensaje: 'LevoPrint se abrirá solo al encender la PC.' });
    });
  });
}

function quitarAccesoInicio() {
  try {
    const r = rutaLnk();
    if (r && fs.existsSync(r)) fs.unlinkSync(r);
  } catch (e) {
    console.error('[inicio] no se pudo quitar el acceso directo: ' + e.message);
    return { ok: false, mensaje: 'No se pudo quitar el arranque automático.' };
  }
  try { editarTxt((txt) => ponerClave(txt, 'LEVO_INICIO', '0')); } catch (_) { /* solo lectura */ }
  process.env.LEVO_INICIO = '0';
  console.log('[inicio] arranque automatico quitado.');
  return { ok: true, mensaje: 'Listo: LevoPrint ya no se abrirá solo. Puedes abrirlo a mano cuando quieras.' };
}

// Al abrir el programa a mano con vínculos: si falta el acceso (versión
// anterior, o se movió el .exe) y el dueño no lo quitó, se crea/corrige.
async function revisarInicioAlArrancar() {
  if (!inicioDisponible() || !vinculos.length || DESDE_INICIO) return;
  if (String(process.env.LEVO_INICIO || '').trim() === '0') return;
  if (inicioActivo() && process.env.LEVO_INICIO_EXE === process.execPath) return;
  await crearAccesoInicio();
}

// Después de un canje exitoso (ventana, .txt o nombre del .exe): ciclo al
// instante, papel de prueba y arranque con Windows.
async function trasVincular(r) {
  despertarCiclo(true);
  // [LP-F3] Primero se buscan impresoras (red y USB, ~3 s): así la app ya las ve y, si la estación
  // aún no tiene impresora, la ventana pregunta «¿Dónde está la impresora de <estación>?».
  try { await buscarImpresoras('vinculo'); } catch (e) { console.error('[buscar] ' + e.message); }
  // [MM4-06] Papel de prueba. [QA BAJO-4] Recanje idempotente (reintento): ya salió la primera vez.
  if (!r.reintento) r.papel = await imprimirVinculado(r.vinculo, r.nombre);
  if (inicioDisponible()) r.inicio = await crearAccesoInicio();
  return r;
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
  const lista = vinculos.map((v) => ({
    prefijo: v.prefijo,
    app: APP_POR_PREFIJO[v.prefijo] || v.prefijo.toUpperCase(),
    nombre: v.nombre || '',
    seccion: seccionVista[v.prefijo] || SECCION_POR_PREFIJO[v.prefijo] || '',
    desactivado: textoDesactivado(v.desactivado),
    ultimaSync: v.ultimaSync,
    // [LP-F3] transporte: true = la app admite impresora por estación; false = app sin actualizar (solo IP).
    transporte: v.transporte,
    estacionVinculo: v.estacionVinculo,
    preguntar: !!v.preguntar,
    estaciones: [...v.estaciones.values()].map((e) => {
      const d = destinoDe(v, e.id) || {};
      return { id: e.id, nombre: e.nombre, ip: d.ip || null, puerto: d.puerto || 9100, transporte: d.transporte || 'red',
        destino: textoDestino(d), imprimible: destinoImprimible(d), propio: d.propio !== false };
    }),
  }));
  revisarKomoAgente(false);
  let semaforo = 'sin_vincular';
  if (sinUrlAnon) semaforo = 'sin_configurar';
  else if (!vinculado) semaforo = 'sin_vincular';
  else if (vinculos.every((v) => v.desactivado)) semaforo = 'desactivado';
  else if (guiEstado.imprimiendo) semaforo = 'imprimiendo';
  else if (guiEstado.ultimoError && (!guiEstado.ultimoOk || guiEstado.ultimoError.ts > guiEstado.ultimoOk)) semaforo = 'sin_impresora';
  else semaforo = 'conectado';
  return {
    ok: true,
    levoprint: true,          // [LP-U1] la otra copia de LevoPrint se reconoce por esto (buscarOtraInstancia)
    version: VERSION_AGENTE,
    modoConsola: MODO_CONSOLA,
    ancho: ANCHO,
    imagen: CON_IMAGEN,
    prefijo: PREFIJO,
    sinUrlAnon,
    vinculado,
    semaforo,
    vinculos: lista,
    // compatibilidad con la ventana anterior: todas las estaciones juntas
    estaciones: lista.flatMap((v) => v.estaciones),
    ultimoError: guiEstado.ultimoError,
    ultimoOk: guiEstado.ultimoOk,
    ultimaSync: Math.max(0, ...vinculos.map((v) => v.ultimaSync || 0)) || null,
    desactivado: vinculos.length && vinculos.every((v) => v.desactivado) ? textoDesactivado(vinculos[0].desactivado) : null,
    inicio: { disponible: inicioDisponible(), activo: inicioActivo() },
    aviso: guiEstado.aviso || null,   // resultado del vínculo automático (nombre del .exe / .txt)
    // [LP-F3] KOMO Agente (programa antiguo) abierto o en el arranque: la ventana ofrece retirarlo.
    komoAgente: { abierto: komoAgente.abierto, enInicio: komoAgente.enInicio, adoptado: komoAgente.adoptado },
    buscando: !!busqueda.enCurso,
  };
}

// [LP-U1] Ventana guiada para alguien que no es técnico: «1. Escribe el código
// que ves en tu app · 2. Listo». Las apps vinculadas se listan con sus
// impresoras y un «Probar» por impresora; los ajustes (papel, logo, arranque
// con Windows) van abajo, en chico. Todo texto del servidor se escapa.
function paginaHtml() {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LevoPrint</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, Segoe UI, Arial, sans-serif; background:#0f1115; color:#e8e8ea; padding:24px; }
  .card { max-width:560px; margin:0 auto; background:#171a21; border:1px solid #262b36; border-radius:14px; padding:22px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:18px 0 8px; }
  .sub { color:#8a8f9c; font-size:13px; margin-bottom:18px; }
  .semaforo { display:flex; align-items:center; gap:10px; padding:12px 14px; border-radius:10px; margin-bottom:16px; font-weight:600; }
  .dot { width:12px; height:12px; border-radius:50%; flex:0 0 auto; }
  .ok { background:#123822; color:#5fe08a; } .ok .dot { background:#5fe08a; }
  .warn { background:#3a2f10; color:#f2c14e; } .warn .dot { background:#f2c14e; }
  .bad { background:#3a1414; color:#ff8080; } .bad .dot { background:#ff8080; }
  .info { background:#12242f; color:#67c1ff; } .info .dot { background:#67c1ff; }
  .paso { display:flex; gap:10px; align-items:flex-start; margin:10px 0; font-size:14px; }
  .num { flex:0 0 auto; width:24px; height:24px; border-radius:50%; background:#3a6df0; color:#fff; font-weight:700; display:flex; align-items:center; justify-content:center; font-size:13px; }
  .fila { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 0; border-top:1px solid #262b36; font-size:14px; }
  .app { border:1px solid #262b36; border-radius:10px; padding:10px 12px; margin-bottom:10px; }
  .app .fila:first-of-type { border-top:none; }
  .muted { color:#8a8f9c; }
  button, input { font: inherit; }
  input[type=text] { width:100%; padding:12px; border-radius:8px; border:1px solid #333a48; background:#0f1115; color:#e8e8ea; margin-bottom:10px; letter-spacing:3px; text-transform:uppercase; font-size:18px; text-align:center; }
  button { padding:10px 16px; border-radius:8px; border:0; background:#3a6df0; color:#fff; cursor:pointer; font-weight:600; }
  button:hover { background:#2f5bd0; }
  button.secundario { background:#262b36; }
  button.chico { padding:6px 10px; font-size:13px; }
  button.ancho { width:100%; padding:12px; }
  button:disabled { opacity:.5; cursor:default; }
  .msg { font-size:13px; margin-top:10px; min-height:16px; }
  .msg.err { color:#ff8080; } .msg.ok { color:#5fe08a; } .msg.warn { color:#f2c14e; }
  details { margin-top:16px; border-top:1px solid #262b36; padding-top:8px; }
  summary { cursor:pointer; color:#8a8f9c; font-size:14px; padding:6px 0; }
  footer { text-align:center; color:#4c5261; font-size:12px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>LevoPrint</h1>
    <div class="sub">Imprime los pedidos y tickets de KOMO, KIPU y KUTI en esta PC.</div>

    <div id="semaforo" class="semaforo info"><span class="dot"></span><span id="semaforoTexto">Cargando...</span></div>

    <div id="vinculoBox">
      <h2 id="vinculoTitulo">Vincula esta PC en 2 pasos</h2>
      <div class="paso"><span class="num">1</span><span>Escribe el código que ves en tu app<br><span class="muted">KOMO › Estaciones, KIPU › Impresoras o KUTI › Impresoras. Son 9 letras y números, y dura 15 minutos.</span></span></div>
      <input id="codigo" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="K1234ABCD">
      <button id="btnVincular" class="ancho">Vincular</button>
      <div id="msgVinculo" class="msg"></div>
      <div class="paso" id="paso2"><span class="num">2</span><span>Listo. Sale un papel de prueba y LevoPrint queda imprimiendo solo. Puedes cerrar esta página; no cierres la ventana negra de LevoPrint (puedes minimizarla).</span></div>
    </div>

    <div id="appsBox"></div>

    <!-- [LP-F3] Elegir la impresora de una estación: lo encontrado en la red y en esta PC; prueba → «¿Salió?» → guardar. -->
    <div id="elegirBox" class="app" style="display:none">
      <h2 id="elegirTitulo" style="margin-top:4px">¿Dónde está la impresora?</h2>
      <div class="muted" style="font-size:13px">Toca «Probar» en una: sale un papel. Si salió, esa es.</div>
      <div id="elegirListas"></div>
      <div id="confirmBox" style="display:none; margin-top:10px">
        <div id="confirmTexto" style="font-weight:600; margin-bottom:8px"></div>
        <button id="btnSalioSi">Sí, salió</button> <button id="btnSalioNo" class="secundario">No salió</button>
      </div>
      <div id="msgElegir" class="msg"></div>
      <div style="margin-top:10px">
        <button id="btnBuscarDeNuevo" class="secundario chico">Buscar de nuevo</button>
        <button id="btnNoLaVeo" class="secundario chico">No la veo</button>
        <button id="btnCerrarElegir" class="secundario chico">Cerrar</button>
      </div>
      <div id="ayudaNoLaVeo" style="display:none; margin-top:10px; font-size:13px">
        <div class="muted">Revisa que la impresora esté encendida. Si es de red, que su cable vaya al mismo router que esta PC (o al mismo Wi-Fi). Si es USB, que esté conectada a esta PC e instalada en Windows. Luego pulsa «Buscar de nuevo».</div>
        <div class="muted" style="margin-top:8px">¿Sabes su IP? (sale en el papel de autoprueba de la impresora)</div>
        <input id="ipManual" type="text" maxlength="21" autocomplete="off" spellcheck="false" placeholder="192.168.1.50" style="letter-spacing:0; text-transform:none; font-size:15px; margin-top:6px">
        <button id="btnProbarIp" class="secundario chico">Probar esta IP</button>
      </div>
    </div>

    <!-- [LP-F3] KOMO Agente (programa antiguo de KOMO) abierto o en el arranque de Windows. -->
    <div id="komoBox" class="app" style="display:none">
      <div id="komoTexto" style="font-size:14px"></div>
      <button id="btnKomo" class="chico" style="margin-top:8px">Cerrar y quitar KOMO Agente</button>
      <div id="msgKomo" class="msg"></div>
    </div>

    <button id="btnPrueba" class="ancho" style="margin-top:6px">Imprimir prueba</button>
    <div id="msgPrueba" class="msg"></div>

    <details>
      <summary>Ajustes</summary>
      <div class="fila">
        <span>Ancho de papel <span id="anchoTexto" class="muted">-</span></span>
        <span><button id="btn58" class="secundario chico">58 mm</button> <button id="btn80" class="secundario chico">80 mm</button></span>
      </div>
      <div class="fila">
        <span>Pie con logo <span id="imagenTexto" class="muted">-</span></span>
        <button id="btnImagen" class="secundario chico">Cambiar</button>
      </div>
      <div class="fila" id="filaInicio">
        <span>Abrir solo al encender la PC <span id="inicioTexto" class="muted">-</span></span>
        <button id="btnInicio" class="secundario chico">-</button>
      </div>
    </details>

    <footer>LevoPrint · LevoDev · levodev.app</footer>
  </div>

<script>
async function j(url, opts) {
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
let ultimo = null;
let avisoVisto = '';

async function refrescar() {
  let e;
  try { e = await j('/estado'); } catch { e = null; }
  if (!e || !e.ok) return;
  ultimo = e;

  const sem = document.getElementById('semaforo');
  const semTxt = document.getElementById('semaforoTexto');
  sem.className = 'semaforo';
  const mapa = {
    sin_configurar: ['bad', 'Falta la dirección del servidor (LEVO_URL / LEVO_ANON en levoprint.txt).'],
    sin_vincular: ['warn', 'Falta vincular: escribe el código de tu app.'],
    imprimiendo: ['ok', 'Imprimiendo...'],
    sin_impresora: ['bad', 'No se pudo imprimir el último trabajo: revisa que la impresora esté encendida y en la misma red.'],
    conectado: ['ok', 'Listo: imprimiendo para ' + (e.vinculos || []).map(function (v) { return v.app; }).join(', ') + '.'],
  };
  let [clase, texto] = mapa[e.semaforo] || ['info', 'Estado desconocido'];
  if (e.semaforo === 'desactivado') { clase = 'bad'; texto = e.desactivado || 'Equipo desactivado desde la consola'; }
  sem.classList.add(clase);
  semTxt.textContent = texto;

  // Aviso del vínculo automático (código en el nombre del programa o en levoprint.txt): se muestra una vez.
  if (e.aviso && avisoVisto !== e.aviso.texto) {
    avisoVisto = e.aviso.texto;
    const m = document.getElementById('msgVinculo');
    m.textContent = e.aviso.texto; m.className = 'msg ' + (e.aviso.clase || '');
  }

  // Sin vínculos: los 2 pasos grandes. Con vínculos: la misma caja sirve para agregar OTRA app.
  document.getElementById('vinculoBox').style.display = e.sinUrlAnon ? 'none' : 'block';
  document.getElementById('vinculoTitulo').textContent = e.vinculado ? '¿Otra app en esta PC? Escribe su código' : 'Vincula esta PC en 2 pasos';
  document.getElementById('paso2').style.display = e.vinculado ? 'none' : 'flex';

  const box = document.getElementById('appsBox');
  box.innerHTML = (e.vinculos || []).map(function (v) {
    let h = '<div class="app"><div class="fila"><b>' + esc(v.app) + '</b><span class="muted">' + esc(v.nombre) + '</span></div>';
    if (v.desactivado) h += '<div class="fila" style="color:#ff8080">' + esc(v.desactivado) + '</div>';
    if (!v.estaciones.length) {
      h += '<div class="fila muted">' + (v.ultimaSync ? 'Sin impresoras todavía: agrégalas en ' + esc(v.app) + (v.seccion ? ' › ' + esc(v.seccion) : '') + '.' : 'Leyendo impresoras...') + '</div>';
    } else {
      // [LP-F3] Cada estación dice dónde imprime (red, USB de esta PC u otro equipo) y trae «Elegir»/«Cambiar».
      h += v.estaciones.map(function (est) {
        const falta = v.transporte === false
          ? 'Falta la IP: escríbela en ' + esc(v.app) + (v.seccion ? ' › ' + esc(v.seccion) : '')
          : 'Falta elegir la impresora';
        const donde = est.destino ? esc(est.destino) : falta;
        const botones = (est.imprimible ? '<button class="secundario chico" data-probar="' + esc(est.id) + '" data-prefijo="' + esc(v.prefijo) + '">Probar</button> ' : '')
          + '<button class="secundario chico" data-elegir="' + esc(est.id) + '" data-prefijo="' + esc(v.prefijo) + '" data-nombre="' + esc(est.nombre) + '">' + (est.destino ? 'Cambiar' : 'Elegir impresora') + '</button>';
        return '<div class="fila"><span>' + esc(est.nombre) + '<br><span class="muted">' + donde + '</span></span><span style="white-space:nowrap">' + botones + '</span></div>';
      }).join('');
    }
    return h + '</div>';
  }).join('');

  document.getElementById('anchoTexto').textContent = '(' + e.ancho + ' columnas, ' + (e.ancho > 56 ? '80 mm' : '58 mm') + ')';
  document.getElementById('imagenTexto').textContent = e.imagen ? '(con logo)' : '(solo texto)';
  const ini = e.inicio || {};
  document.getElementById('filaInicio').style.display = ini.disponible ? 'flex' : 'none';
  document.getElementById('inicioTexto').textContent = ini.activo ? '(sí)' : '(no)';
  document.getElementById('btnInicio').textContent = ini.activo ? 'Quitar' : 'Activar';
  document.getElementById('btnPrueba').disabled = !e.vinculado;

  // [LP-F3] KOMO Agente (programa antiguo) abierto o en el arranque: se ofrece cerrarlo y quitarlo.
  const ka = e.komoAgente || {};
  document.getElementById('komoBox').style.display = (ka.abierto || ka.enInicio) ? 'block' : 'none';
  document.getElementById('komoTexto').textContent = ka.abierto
    ? 'El programa antiguo de KOMO (KOMO Agente) sigue abierto. LevoPrint ya imprime lo de KOMO: ciérralo para que no se repartan los pedidos entre los dos.'
    : 'El programa antiguo de KOMO (KOMO Agente) se abre solo al encender la PC. Ya no hace falta: quítalo.';

  // [LP-F3] Tras vincular (o si la estación del código no tiene impresora) se pregunta sola, una vez.
  if (!eleccion) {
    for (const v of (e.vinculos || [])) {
      if (v.desactivado || v.transporte === null) continue;
      const sin = v.estaciones.filter(function (s) { return !s.imprimible && !cerrados[v.prefijo + '|' + s.id]; });
      const est = sin.find(function (s) { return s.id === v.estacionVinculo; }) || (v.preguntar ? sin[0] : null);
      if (est) { abrirElegir(v.prefijo, est.id, est.nombre); break; }
    }
  }
}

// ---- [LP-F3] «¿Dónde está la impresora de <estación>?» ----
let eleccion = null;   // { prefijo, estacion, nombre } abierta ahora
let probada = null;    // { transporte, ref, nombre } a la espera de «¿Salió?»
const cerrados = {};   // prefijo|estación que el dueño cerró: no se vuelve a abrir sola
function vinculoVisto(prefijo) { return ((ultimo && ultimo.vinculos) || []).find(function (v) { return v.prefijo === prefijo; }) || {}; }
function msgElegir(texto, clase) { const m = document.getElementById('msgElegir'); m.textContent = texto || ''; m.className = 'msg ' + (clase || ''); }
function abrirElegir(prefijo, estacion, nombre) {
  eleccion = { prefijo: prefijo, estacion: estacion, nombre: nombre };
  probada = null;
  document.getElementById('elegirTitulo').textContent = '¿Dónde está la impresora de ' + nombre + '?';
  document.getElementById('confirmBox').style.display = 'none';
  document.getElementById('ayudaNoLaVeo').style.display = 'none';
  document.getElementById('elegirBox').style.display = 'block';
  msgElegir('', '');
  j('/impresoras').then(pintarImpresoras);
  document.getElementById('elegirBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cerrarElegir() {
  if (eleccion) cerrados[eleccion.prefijo + '|' + eleccion.estacion] = true;
  eleccion = null; probada = null;
  document.getElementById('elegirBox').style.display = 'none';
}
function botonImpresora(t, x) {
  let sub = '';
  if (t === 'usb') sub = (x.detalle && x.detalle.modelo ? x.detalle.modelo : '') + (x.detalle && x.detalle.probableTermica ? ' · parece de tickets' : '');
  else sub = x.ref;
  return '<div class="fila"><span>' + esc(x.nombre) + '<br><span class="muted">' + esc(sub) + '</span></span>'
    + '<button class="chico" data-t="' + esc(t) + '" data-ref="' + esc(x.ref) + '" data-n="' + esc(x.nombre) + '">Probar</button></div>';
}
function pintarImpresoras(r) {
  if (!eleccion || !r || !r.ok) return;
  const v = vinculoVisto(eleccion.prefijo);
  const red = r.red || [], usb = v.transporte === false ? [] : (r.usb || []);
  let h = '<h2>En la red</h2>' + (red.length ? red.map(function (x) { return botonImpresora('red', x); }).join('') : '<div class="fila muted">No encontramos impresoras de red.</div>');
  if (v.transporte !== false) {
    h += '<h2>Conectadas a esta PC (USB)</h2>' + (usb.length ? usb.map(function (x) { return botonImpresora('usb', x); }).join('') : '<div class="fila muted">No hay impresoras instaladas en esta PC.</div>');
    if (r.usbAviso) h += '<div class="msg warn">' + esc(r.usbAviso) + '</div>';
  } else {
    h += '<div class="msg warn">Tu app todavía no admite impresoras USB: por ahora elige una de red.</div>';
  }
  if (r.buscando) h += '<div class="msg">Buscando…</div>';
  document.getElementById('elegirListas').innerHTML = h;
}
async function probarDestino(t, ref, nombre) {
  if (!eleccion) return;
  probada = null;
  document.getElementById('confirmBox').style.display = 'none';
  msgElegir('Enviando un papel de prueba a ' + nombre + '…', '');
  let r = null;
  try { r = await j('/probar-destino', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefijo: eleccion.prefijo, estacion: eleccion.estacion, transporte: t, ref: ref }) }); } catch (_) { r = null; }
  if (!r || !r.ok) { msgElegir((r && r.mensaje) || 'No se pudo enviar la prueba.', 'err'); return; }
  probada = { transporte: t, ref: ref, nombre: nombre };
  msgElegir('', '');
  document.getElementById('confirmTexto').textContent = 'Enviamos un papel de prueba a ' + nombre + '. ¿Salió?';
  document.getElementById('confirmBox').style.display = 'block';
}
document.getElementById('elegirListas').addEventListener('click', function (ev) {
  const b = ev.target.closest('button[data-t]');
  if (b) probarDestino(b.getAttribute('data-t'), b.getAttribute('data-ref'), b.getAttribute('data-n'));
});
document.getElementById('btnSalioSi').addEventListener('click', async function () {
  if (!eleccion || !probada) return;
  const btn = this; btn.disabled = true;
  msgElegir('Guardando…', '');
  let r = null;
  try { r = await j('/elegir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefijo: eleccion.prefijo, estacion: eleccion.estacion, transporte: probada.transporte, ref: probada.ref, nombre: probada.nombre }) }); } catch (_) { r = null; }
  btn.disabled = false;
  document.getElementById('confirmBox').style.display = 'none';
  if (r && r.ok) {
    msgElegir(r.mensaje || 'Listo.', 'ok');
    const cerrar = eleccion;
    setTimeout(function () { if (eleccion === cerrar) cerrarElegir(); }, 2500);
  } else msgElegir((r && r.mensaje) || 'No se pudo guardar. Revisa tu internet e intenta de nuevo.', r && r.modo112 ? 'warn' : 'err');
  refrescar();
});
document.getElementById('btnSalioNo').addEventListener('click', function () {
  probada = null;
  document.getElementById('confirmBox').style.display = 'none';
  msgElegir('Prueba con otra de la lista. Si ninguna sale, revisa que la impresora esté encendida y conectada, y pulsa «Buscar de nuevo».', 'warn');
});
document.getElementById('btnBuscarDeNuevo').addEventListener('click', async function () {
  const btn = this; btn.disabled = true;
  msgElegir('Buscando impresoras (unos segundos)…', '');
  let r = null;
  try { r = await j('/buscar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) { r = null; }
  btn.disabled = false;
  msgElegir('', '');
  pintarImpresoras(r);
});
document.getElementById('btnNoLaVeo').addEventListener('click', function () {
  const a = document.getElementById('ayudaNoLaVeo');
  a.style.display = a.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('btnProbarIp').addEventListener('click', function () {
  const ip = document.getElementById('ipManual').value.trim();
  if (!ip) { msgElegir('Escribe la IP de la impresora. Ejemplo: 192.168.1.50', 'err'); return; }
  probarDestino('red', ip, ip);
});
document.getElementById('btnCerrarElegir').addEventListener('click', cerrarElegir);
document.getElementById('btnKomo').addEventListener('click', async function () {
  const btn = this; btn.disabled = true;
  const m = document.getElementById('msgKomo');
  let r = null;
  try { r = await j('/komo-agente/retirar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) { r = null; }
  btn.disabled = false;
  m.textContent = (r && r.mensaje) || 'No se pudo. Intenta de nuevo.'; m.className = 'msg ' + (r && r.ok ? 'ok' : 'err');
  refrescar();
});

async function probar(cuerpo) {
  const msg = document.getElementById('msgPrueba');
  msg.textContent = 'Imprimiendo...'; msg.className = 'msg';
  let r = null;
  try { r = await j('/prueba', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}) }); } catch (_) { r = null; }
  if (r && r.ok) { msg.textContent = r.aviso || 'Prueba enviada.'; msg.className = 'msg ' + (r.parcial ? 'warn' : 'ok'); }
  else { msg.textContent = (r && r.mensaje) || 'No se pudo imprimir.'; msg.className = 'msg err'; }
  refrescar();
}

document.getElementById('btnVincular').addEventListener('click', async function () {
  const codigo = document.getElementById('codigo').value.trim();
  const msg = document.getElementById('msgVinculo');
  if (!codigo) { msg.textContent = 'Escribe el código que ves en tu app.'; msg.className = 'msg err'; return; }
  // [MM4-06] «Vinculando…» con el boton deshabilitado; exito en verde y error en rojo.
  const btn = document.getElementById('btnVincular');
  btn.disabled = true;
  msg.textContent = 'Vinculando…'; msg.className = 'msg';
  let r = null;
  try { r = await j('/vincular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: codigo }) }); } catch (_) { r = null; }
  btn.disabled = false;
  if (r && r.ok) {
    const txt = 'Listo: ' + (r.app ? r.app + ' quedó vinculado' : 'vinculado') + (r.nombre ? ' como ' + r.nombre : '') + '.'
      + (r.aviso ? ' ' + r.aviso : '') + (r.papel && r.papel.mensaje ? ' ' + r.papel.mensaje : '');
    msg.textContent = txt; msg.className = 'msg ' + ((r.papel && r.papel.ok === false) || r.guardado === false ? 'warn' : 'ok');
    document.getElementById('codigo').value = '';
  }
  else { msg.textContent = (r && r.mensaje) || 'No se pudo vincular. Revisa tu internet e intenta de nuevo.'; msg.className = 'msg err'; }
  refrescar();
});
document.getElementById('codigo').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') document.getElementById('btnVincular').click(); });

document.getElementById('btnPrueba').addEventListener('click', function () { probar({}); });
document.getElementById('appsBox').addEventListener('click', function (ev) {
  const b = ev.target.closest('button[data-probar]');
  if (b) probar({ estacion: b.getAttribute('data-probar'), prefijo: b.getAttribute('data-prefijo') });
  const el = ev.target.closest('button[data-elegir]');
  if (el) abrirElegir(el.getAttribute('data-prefijo'), el.getAttribute('data-elegir'), el.getAttribute('data-nombre'));
});

function cambiarAncho(v) {
  const msg = document.getElementById('msgPrueba');
  j('/ancho', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ancho: v }) })
    .then(function (r) { msg.textContent = (r && r.ok) ? 'Ancho actualizado.' : 'No se pudo cambiar.'; msg.className = 'msg ' + ((r && r.ok) ? 'ok' : 'err'); refrescar(); });
}
document.getElementById('btnImagen').addEventListener('click', function () {
  const msg = document.getElementById('msgPrueba');
  j('/imagen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imagen: !(ultimo && ultimo.imagen) }) })
    .then(function (r) { msg.textContent = (r && r.ok) ? (r.imagen ? 'El pie sale con el logo.' : 'El pie sale solo en texto.') : 'No se pudo cambiar.'; msg.className = 'msg ' + ((r && r.ok) ? 'ok' : 'err'); refrescar(); });
});
document.getElementById('btnInicio').addEventListener('click', async function () {
  const msg = document.getElementById('msgPrueba');
  const btn = this;
  btn.disabled = true;
  const activo = !!(ultimo && ultimo.inicio && ultimo.inicio.activo);
  let r = null;
  try { r = await j('/inicio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activo: !activo }) }); } catch (_) { r = null; }
  btn.disabled = false;
  msg.textContent = (r && r.mensaje) || 'No se pudo cambiar.'; msg.className = 'msg ' + ((r && r.ok) ? 'ok' : 'err');
  refrescar();
});
document.getElementById('btn58').addEventListener('click', function () { cambiarAncho(48); });
document.getElementById('btn80').addEventListener('click', function () { cambiarAncho(64); });

refrescar();
setInterval(refrescar, 2500);
</script>
</body>
</html>`;
}

// [LP-U1] «Imprimir prueba»: una hoja por IMPRESORA (ip:puerto) de todas las
// apps vinculadas, cada una con el pie de SU app; o solo la estación del botón
// «Probar» ({ estacion, prefijo }). Así el dueño ve en papel cuál funciona.
async function manejarPrueba(req, res) {
  if (faltaConfig()) return responderJson(res, 400, { ok: false, error: 'SIN_VINCULAR', mensaje: 'Primero vincula esta PC con el código de tu app.' });
  const body = await leerBodyJson(req);
  let destinos = [];
  // [LP-F3] Cada estación con su destino (red o USB de esta PC), no solo la IP.
  for (const v of vinculos) for (const id of v.estaciones.keys()) destinos.push({ v, est: destinoDe(v, id) });
  if (body.estacion) destinos = destinos.filter((d) => String(d.est.estacion) === String(body.estacion) && (!body.prefijo || d.v.prefijo === body.prefijo));
  const vistos = new Set();
  const unicos = destinos.filter((d) => {
    if (!destinoImprimible(d.est)) return false;
    const k = claveDestino(d.est);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  if (MODO_CONSOLA || !unicos.length) {
    const texto = conPrefijo((destinos[0] || { v: vinculos[0] }).v.prefijo, () => render({ tipo: 'PRUEBA', payload: {} }));
    console.log('[prueba] ' + paraConsola(texto));
    if (MODO_CONSOLA) return responderJson(res, 200, { ok: true, aviso: 'Modo consola: la prueba se mostró en la consola.' });
    return responderJson(res, 400, {
      ok: false, error: 'SIN_IMPRESORA',
      mensaje: !destinos.length
        ? 'Todavía no hay impresoras: agrégalas en tu app (Estaciones o Impresoras) y vuelve a probar en un minuto.'
        : 'Falta elegir la impresora: pulsa «Elegir impresora» junto a la estación.',
    });
  }
  const bien = [], mal = [];
  for (const d of unicos) {
    const etiqueta = d.est.nombre + ' (' + textoDestino(d.est) + ')';
    try {
      await imprimirDestino(d.est, conPrefijo(d.v.prefijo, () => render({ tipo: 'PRUEBA', payload: {} })));
      bien.push(etiqueta);
    } catch (e) {
      mal.push(etiqueta);
      console.error('[prueba] ' + d.est.nombre + ': ' + e.message);
    }
  }
  if (bien.length) guiEstado.ultimoOk = Date.now();
  if (!bien.length) {
    guiEstado.ultimoError = { mensaje: 'prueba sin respuesta', ts: Date.now() };
    return responderJson(res, 500, { ok: false, error: 'IMPRESION', mensaje: 'No respondió: ' + mal.join(', ') + '. Revisa que la impresora esté encendida y conectada.' });
  }
  return responderJson(res, 200, {
    ok: true, parcial: mal.length > 0,
    aviso: 'Prueba enviada a ' + bien.join(', ') + '.' + (mal.length ? ' No respondió: ' + mal.join(', ') + '; revisa que esté encendida y conectada.' : ''),
  });
}

// ============================================================
// [LP-F3] «¿Dónde está la impresora de <estación>?» — endpoints de la ventana.
// Pasan por las MISMAS guardas que el resto (Host exacto, Origin propio, POST
// solo con application/json: peticionLocalValida, en iniciarGui).
// ============================================================
function vinculoDe(prefijo) { return vinculos.find((v) => v.prefijo === String(prefijo || '').toLowerCase()) || null; }
function resumenImpresoras() {
  return {
    ok: true, buscando: !!busqueda.enCurso, ts: busqueda.ts || null, equipo: nombreEquipo(),
    red: busqueda.red, usb: busqueda.usb, usbAviso: busqueda.usbAviso || textoUsbAviso(),
  };
}
// Valida lo que llega de la ventana: red = IPv4 (y puerto) bien formada; USB = una cola que la búsqueda vio en esta PC.
function refValida(transporte, ref) {
  ref = String(ref || '').trim();
  if (transporte === 'red') {
    const m = ref.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/);
    if (!m || m.slice(1, 5).some((x) => +x > 255) || (m[5] && (+m[5] < 1 || +m[5] > 65535))) return null;
    const ip = m.slice(1, 5).map((x) => String(+x)).join('.');
    return { transporte: 'red', ip, puerto: parseInt(m[5] || '9100', 10), ref: ip + ':' + (m[5] || '9100'), nombre: 'Impresora en ' + ip };
  }
  if (transporte === 'usb') {
    const u = busqueda.usb.find((x) => x.ref === ref);
    return u ? { transporte: 'usb', usbId: u.ref, ref: u.ref, nombre: u.nombre } : null;
  }
  return null;
}
async function manejarImpresoras(req, res) { return responderJson(res, 200, resumenImpresoras()); }
async function manejarBuscar(req, res) {
  await leerBodyJson(req);
  try { await buscarImpresoras('ventana'); } catch (e) { console.error('[buscar] ' + e.message); }
  return responderJson(res, 200, resumenImpresoras());
}
async function manejarProbarDestino(req, res) {
  const body = await leerBodyJson(req);
  const v = vinculoDe(body.prefijo) || vinculos[0];
  const d = refValida(body.transporte, body.ref);
  if (!d) return responderJson(res, 400, { ok: false, error: 'DESTINO_INVALIDO', mensaje: body.transporte === 'red' ? 'Esa IP no es válida. Ejemplo: 192.168.1.50' : 'No encuentro esa impresora: pulsa «Buscar de nuevo».' });
  const texto = conPrefijo(v ? v.prefijo : PREFIJO, () => render({ tipo: 'PRUEBA', payload: {} }));
  if (MODO_CONSOLA) { console.log('[probar] ' + paraConsola(texto)); return responderJson(res, 200, { ok: true, mensaje: 'Modo consola: la prueba se mostró en la consola.' }); }
  try {
    await imprimirDestino({ ...d, propio: true }, texto);
    console.log('[probar] papel de prueba -> ' + d.transporte + ' ' + d.ref);
    return responderJson(res, 200, { ok: true, mensaje: 'Enviamos un papel de prueba. ¿Salió?' });
  } catch (e) {
    console.error('[probar] ' + d.ref + ': ' + e.message);
    return responderJson(res, 200, { ok: false, error: e.codigoLp || 'IMPRESION', mensaje: e.codigoLp === 'POWERSHELL_RESTRINGIDO' ? textoUsbAviso() : 'No respondió: revisa que esté encendida y conectada, o prueba con otra.' });
  }
}
async function manejarElegir(req, res) {
  const body = await leerBodyJson(req);
  const v = vinculoDe(body.prefijo);
  if (!v) return responderJson(res, 400, { ok: false, error: 'SIN_VINCULO', mensaje: 'Esa app no está vinculada en esta PC.' });
  const est = v.estaciones.get(String(body.estacion || ''));
  if (!est) return responderJson(res, 400, { ok: false, error: 'ESTACION_NO_EXISTE', mensaje: ERRORES_ELEGIR.ESTACION_NO_EXISTE });
  const d = refValida(body.transporte, body.ref);
  if (!d) return responderJson(res, 400, { ok: false, error: 'DESTINO_INVALIDO', mensaje: 'No encuentro esa impresora: pulsa «Buscar de nuevo».' });
  // App sin actualizar (backend sin la RPC): como la 1.12, el dueño escribe la IP en su consola.
  const modo112 = () => responderJson(res, 200, {
    ok: false, modo112: true, error: 'APP_SIN_ACTUALIZAR',
    mensaje: d.transporte === 'red'
      ? 'Escribe esta IP en ' + consolaDe(v.prefijo) + ' (estación ' + est.nombre + '): ' + d.ip + (d.puerto !== 9100 ? ' puerto ' + d.puerto : '') + '.'
      : 'Tu app todavía no admite impresoras USB. Por ahora usa una impresora de red.',
  });
  if (v.transporte === false && v.sinTransporteHasta > Date.now()) return modo112();
  const r = await elegirDestino(v, est.id, d.transporte, d.ref, body.nombre || d.nombre || '');
  if (r.modo112) return modo112();
  if (!r.ok) return responderJson(res, 200, r);
  v.preguntar = false;
  console.log('[elegir] ' + v.prefijo + ' ' + est.nombre + ' -> ' + d.transporte + ' ' + d.ref);
  return responderJson(res, 200, { ok: true, mensaje: 'Listo: ' + est.nombre + ' imprime en ' + (d.transporte === 'usb' ? 'la impresora USB «' + d.nombre + '»' : d.ip) + '.' });
}
async function manejarKomoRetirar(req, res) {
  await leerBodyJson(req);
  const r = await retirarKomoAgente();
  return responderJson(res, r.ok ? 200 : 400, r);
}

async function manejarVincular(req, res) {
  const body = await leerBodyJson(req);
  const r = await canjearCodigo(body.codigo);
  if (r.ok) {
    console.log('[gui] vinculado desde la ventana (' + r.prefijo + '). Arrancando ciclo de impresion...');
    guiEstado.aviso = null;
    // Token nuevo: vuelta inmediata con config fresca (arranca el bucle si no
    // había vínculos, o corta la pausa si estaba desactivado), papel de prueba
    // [MM4-06] y arranque con Windows [LP-U1].
    await trasVincular(r);
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

async function manejarImagen(req, res) {
  const body = await leerBodyJson(req);
  if (typeof body.imagen !== 'boolean') return responderJson(res, 400, { ok: false, error: 'IMAGEN_INVALIDA' });
  CON_IMAGEN = body.imagen;
  process.env.LEVO_IMAGEN = CON_IMAGEN ? '1' : '0';
  return responderJson(res, 200, { ok: true, imagen: CON_IMAGEN, persistido: persistirImagen(CON_IMAGEN ? '1' : '0') });
}

// [LP-U1] Botón «Activar / Quitar» del arranque con Windows.
// [QA LP-U1 · BAJO-b] Otra copia (de otra versión) que se cerró deja su aviso en esta ventana.
async function manejarAviso(req, res) {
  const body = await leerBodyJson(req);
  const texto = String(body.texto || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300);
  if (!texto) return responderJson(res, 400, { ok: false, error: 'AVISO_VACIO' });
  console.log('[aviso] ' + texto);
  guiEstado.aviso = { clase: 'warn', texto };
  return responderJson(res, 200, { ok: true });
}

async function manejarInicio(req, res) {
  const body = await leerBodyJson(req);
  if (typeof body.activo !== 'boolean') return responderJson(res, 400, { ok: false, error: 'INICIO_INVALIDO' });
  const r = body.activo ? await crearAccesoInicio() : quitarAccesoInicio();
  return responderJson(res, r.ok ? 200 : 500, { ...r, activo: inicioActivo() });
}

function abrirNavegador(url) {
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
              : process.platform === 'darwin' ? `open "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, () => {}); // si falla (sin entorno grafico), no pasa nada: la GUI sigue servida
  } catch { /* nada: entorno sin navegador */ }
}

function peticionLocalValida(req, servidor) {
  const dir = servidor.address();
  const puerto = dir && typeof dir === 'object' ? dir.port : 0;
  const permitidos = ['127.0.0.1:' + puerto, 'localhost:' + puerto];
  if (!permitidos.includes(String(req.headers.host || '').toLowerCase())) return false;
  const origen = req.headers.origin;
  if (origen !== undefined && !permitidos.map((h) => 'http://' + h).includes(String(origen).toLowerCase())) return false;
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return false;
  return req.method === 'GET' || req.method === 'POST';
}

// Intenta 9110..9114 por si el puerto base ya esta ocupado (dos agentes,
// otro programa, etc). No bloquea el ciclo de impresion si falla del todo.
function iniciarGui() {
  const servidor = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    // [QA LP-U1 · ALTO 1] Anti CSRF / DNS rebinding: una página cualquiera abierta en el navegador
    // de la PC NO puede vincular, imprimir ni cambiar el arranque. (a) Host exacto 127.0.0.1:<puerto>
    // o localhost:<puerto> (un dominio rebindeado a 127.0.0.1 trae su propio Host); (b) si viene
    // Origin, el mismo de la ventana; (c) todo POST con Content-Type application/json, que obliga al
    // navegador a hacer preflight (OPTIONS), que aquí no se responde. El reenvío entre instancias
    // (fetch de Node) no manda Origin y sí el Host correcto.
    if (!peticionLocalValida(req, servidor)) return responderJson(res, 403, { ok: false, error: 'PROHIBIDO' });
    if (req.method === 'GET' && url === '/') {
      // [qa5] Abrir la ventana con algún vínculo desactivado = reintento ya
      // (con tope de uno cada 10 s; /estado, que se sondea, NO despierta).
      if (vinculos.some((v) => v.desactivado) && Date.now() - ultimoDespertarGui > 10000) {
        ultimoDespertarGui = Date.now();
        despertarCiclo(true);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(paginaHtml());
    }
    if (req.method === 'GET' && url === '/estado') return responderJson(res, 200, estadoActual());
    if (req.method === 'POST' && url === '/prueba') return void manejarPrueba(req, res);
    if (req.method === 'POST' && url === '/vincular') return void manejarVincular(req, res);
    if (req.method === 'POST' && url === '/ancho') return void manejarAncho(req, res);
    if (req.method === 'POST' && url === '/imagen') return void manejarImagen(req, res);
    if (req.method === 'POST' && url === '/inicio') return void manejarInicio(req, res);
    if (req.method === 'POST' && url === '/aviso') return void manejarAviso(req, res);
    // [LP-F3] Impresora por estación: lista, búsqueda, prueba en un destino y elección.
    if (req.method === 'GET' && url === '/impresoras') return void manejarImpresoras(req, res);
    if (req.method === 'POST' && url === '/buscar') return void manejarBuscar(req, res);
    if (req.method === 'POST' && url === '/probar-destino') return void manejarProbarDestino(req, res);
    if (req.method === 'POST' && url === '/elegir') return void manejarElegir(req, res);
    if (req.method === 'POST' && url === '/komo-agente/retirar') return void manejarKomoRetirar(req, res);
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

// [LP-U1] ¿Ya hay un LevoPrint abierto en esta PC (p. ej. el de KOMO, y ahora
// se abre el .exe que bajó KUTI)? Se busca en 9110-9114 una ventana que diga
// levoprint:true con la MISMA versión. Si la hay, este proceso le pasa el
// código (si trae uno), abre su ventana y se cierra: un solo LevoPrint
// atiende todas las apps.
// [QA LP-U1 · MEDIO 2] Con OTRA versión tampoco se arranca un segundo ciclo de
// impresión (dos procesos tomando la misma cola): se le pasa el código, se
// avisa «ciérralo y vuelve a abrir este» y se sale. Las ventanas 1.11 o
// anteriores no dicen levoprint:true; se reconocen por version + semaforo.
async function buscarOtraInstancia() {
  for (let i = 0; i < 5; i++) {
    const puerto = PUERTO_GUI_BASE + i;
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/estado`, { signal: AbortSignal.timeout(1500) });
      const e = await r.json();
      const esLevoPrint = e && (e.levoprint === true || (typeof e.version === 'string' && typeof e.semaforo === 'string'));
      if (esLevoPrint) return { puerto, estado: e, mismaVersion: e.version === VERSION_AGENTE };
    } catch (_) { /* nadie en ese puerto */ }
  }
  return null;
}

// Errores tras los que el código del nombre del .exe NO se vuelve a intentar
// (todos menos los pasajeros: red, freno por intentos, IP).
const ERRORES_PASAJEROS = ['RED', 'DEMASIADOS_INTENTOS', 'IP_DESCONOCIDA', 'FALTA_URL_ANON'];
function codigosArchivoUsados() {
  return String(process.env.LEVO_CODIGOS_ARCHIVO || '').split(',').map(normalizarCodigo).filter(Boolean);
}
function recordarCodigoArchivo(cod, r) {
  if (!cod || (r && !r.ok && ERRORES_PASAJEROS.includes(r.error))) return;
  // Se guardan los últimos 20 (de sobra: cada código es de un uso y dura 15 min).
  const lista = codigosArchivoUsados().filter((c) => c !== cod).concat(cod).slice(-20).join(',');
  try { editarTxt((txt) => ponerClave(txt, 'LEVO_CODIGOS_ARCHIVO', lista)); } catch (_) { /* solo lectura: se reintentaría al reabrir */ }
  process.env.LEVO_CODIGOS_ARCHIVO = lista;
}

// [QA LP-U1 · BAJO-a] Candado de una instancia: dos arranques A LA VEZ (autoarranque de Windows +
// doble clic) no se ven por el puerto (ninguno escucha aún) y quedarían dos ciclos. levoprint.lock
// guarda el pid; se crea con 'wx' (atómico). Si ya existe y ese pid sigue vivo, este proceso se
// comporta como «otra instancia» (reenvía el código / avisa y sale); si el pid murió (corte de
// luz, cierre forzado), se retoma. Va en %LOCALAPPDATA%\LevoPrint (uno por usuario de Windows,
// aunque haya .exe en varias carpetas); sin LOCALAPPDATA, en la carpeta del .txt.
// LEVO_LOCK_DIR solo para pruebas.
const DIR_LOCK = process.env.LEVO_LOCK_DIR || DIR_RESPALDO || DIR_TXT;
const RUTA_LOCK = path.join(DIR_LOCK, 'levoprint.lock');
let lockMio = false;
function pidVivo(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// Devuelve 0 si el candado es nuestro, o el pid vivo que lo tiene.
function tomarLock() {
  try { fs.mkdirSync(DIR_LOCK, { recursive: true }); } catch { /* ya existe */ }
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = fs.openSync(RUTA_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockMio = true;
      return 0;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return 0; // carpeta sin permisos: se sigue sin candado (como antes)
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(RUTA_LOCK, 'utf8'), 10) || 0; } catch { /* a medio escribir */ }
      if (pidVivo(pid)) return pid;
      try { fs.unlinkSync(RUTA_LOCK); } catch { /* otro lo retomó primero: se reintenta */ }
    }
  }
  return -1; // otro proceso lo retomó en la misma carrera
}
function soltarLock() {
  if (!lockMio) return;
  lockMio = false;
  try { if (parseInt(fs.readFileSync(RUTA_LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(RUTA_LOCK); } catch { /* nada */ }
}
process.on('exit', soltarLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { soltarLock(); process.exit(0); }); } catch { /* señal no soportada */ }
}

// El dueño del candado aún no abre su ventana: se espera hasta 15 s a que aparezca.
async function esperarOtraInstancia() {
  for (let i = 0; i < 15; i++) {
    const otra = await buscarOtraInstancia();
    if (otra) return otra;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// Comportamiento «ya hay un LevoPrint abierto»: le pasa el código, abre su ventana y sale.
// [QA LP-U1 · BAJO-b] Con OTRA versión deja constancia en levoprint.log (fecha, versiones) y
// en la ventana del abierto (POST /aviso), sobre todo en el arranque con Windows, donde nadie
// ve la consola.
async function usarOtraInstancia(otra, codigoInicial, delArchivo) {
  const url = `http://127.0.0.1:${otra.puerto}`;
  console.log('LevoPrint ya esta abierto en esta PC (' + url + '): se usa ese.');
  if (codigoInicial) {
    let r = null;
    try {
      const resp = await fetch(url + '/vincular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo: codigoInicial }), signal: AbortSignal.timeout(60000),
      });
      r = await resp.json();
    } catch (e) { r = { ok: false, error: 'RED', mensaje: e.message }; }
    console.log(r && r.ok ? 'Vinculado en el LevoPrint abierto: ' + (r.app || '') + ' ' + (r.nombre || '') : 'No se pudo vincular: ' + ((r && r.mensaje) || 'error'));
    if (delArchivo) recordarCodigoArchivo(codigoInicial, r);
  }
  if (!DESDE_INICIO) abrirNavegador(url);
  if (!otra.mismaVersion) {
    const texto = 'LevoPrint ya está abierto (versión ' + otra.estado.version + '): ciérralo y vuelve a abrir este (versión ' + VERSION_AGENTE + ').';
    console.error('\n' + texto + '\n');
    console.error('[instancia] ' + new Date().toISOString() + ' sali sin imprimir: version propia ' + VERSION_AGENTE
      + ', version abierta ' + otra.estado.version + (DESDE_INICIO ? ' (arranque con Windows)' : '') + ' — ' + BASE_DIR);
    try {
      await fetch(url + '/aviso', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: 'Se intentó abrir LevoPrint ' + VERSION_AGENTE + (DESDE_INICIO ? ' al encender la PC' : '')
          + ' y se cerró porque este (versión ' + otra.estado.version + ') ya estaba abierto. Para actualizar, cierra este y abre el nuevo.' }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) { /* versiones anteriores no tienen /aviso */ }
    setTimeout(() => process.exit(0), DESDE_INICIO ? 1500 : 20000);
    return;
  }
  setTimeout(() => process.exit(0), 1500);
}

async function arrancar() {
  // Código pendiente: el de levoprint.txt (LEVO_CODIGO) o, si no hay, el del
  // nombre del .exe si aún no se usó.
  let codigoInicial = CODIGO, delArchivo = false;
  if (!codigoInicial && CODIGO_ARCHIVO && !codigosArchivoUsados().includes(CODIGO_ARCHIVO)) {
    codigoInicial = CODIGO_ARCHIVO;
    delArchivo = true;
  }

  // [QA LP-U1 · BAJO-a] Primero el candado (carrera de dos arranques a la vez), luego el puerto
  // (otra copia en otra carpeta, o una versión anterior sin candado).
  const duenoLock = tomarLock();
  if (duenoLock !== 0) {
    const otraL = await esperarOtraInstancia();
    if (otraL) return usarOtraInstancia(otraL, codigoInicial, delArchivo);
    console.error('[instancia] ' + new Date().toISOString() + ' LevoPrint ya se esta abriendo (pid ' + duenoLock + ') y su ventana no respondio: salgo sin imprimir.');
    setTimeout(() => process.exit(0), DESDE_INICIO ? 1500 : 10000);
    return;
  }
  const otra = await buscarOtraInstancia();
  if (otra) return usarOtraInstancia(otra, codigoInicial, delArchivo);

  if (faltaUrlAnon()) {
    console.error('Falta LEVO_URL/LEVO_ANON: revisa levoprint.txt (o borra esas lineas para usar las de LevoPrint).');
  }
  console.log('LevoPrint agente de impresion v' + VERSION_AGENTE + ' (vincular con el codigo + varias apps + impresora por estacion) - LevoDev');
  console.log(MODO_CONSOLA ? 'MODO CONSOLA (sin impresoras reales)' : 'Modo impresión real');
  migrarConfigVieja();
  // [LP-F3] komo-agente.txt en la misma carpeta: se adopta su vínculo (mismo token, sin código).
  adoptarKomoAgente();
  revisarKomoAgente(true);
  iniciarGui();
  // [LP-F3] Búsqueda de impresoras al arrancar y cada 15 min (además: tras vincular, cuando la
  // consola la pide con buscar:true y con «Buscar de nuevo» en la ventana).
  setTimeout(() => { if (vinculos.length) buscarImpresoras('arranque').catch(() => {}); }, 1500);
  setInterval(() => { if (vinculos.length) buscarImpresoras('cada 15 min').catch(() => {}); }, BUSCAR_CADA_MS);
  if (!faltaConfig()) {
    console.log('Apps vinculadas: ' + vinculos.map((v) => v.prefijo).join(', '));
    ciclo();
  } else if (!codigoInicial) {
    console.log('Falta vincular: en la ventana de LevoPrint escribe el codigo que ves en tu app.');
  }

  if (codigoInicial) {
    guiEstado.aviso = { clase: '', texto: 'Vinculando con el código ' + codigoInicial + '...' };
    const r = await canjearCodigo(codigoInicial);
    if (!delArchivo) CODIGO = ''; // el del .txt se intenta UNA vez por sesion (el canje es de un uso)
    if (delArchivo) recordarCodigoArchivo(codigoInicial, r);
    if (r.ok) {
      await trasVincular(r);
      guiEstado.aviso = {
        clase: (r.papel && r.papel.ok === false) || r.guardado === false ? 'warn' : 'ok',
        texto: 'Listo: ' + r.app + ' quedó vinculado' + (r.nombre ? ' como ' + r.nombre : '') + '.' + (r.aviso ? ' ' + r.aviso : '')
          + (r.papel && r.papel.mensaje ? ' ' + r.papel.mensaje : ''),
      };
    } else {
      // Ya vinculado con ese código (se abrió de nuevo el mismo .exe): no es un error para el dueño.
      guiEstado.aviso = (r.error === 'CODIGO_USADO' && vinculos.some((v) => v.prefijo === PREFIJO_POR_LETRA[codigoInicial.charAt(0)]))
        ? null : { clase: 'err', texto: r.mensaje };
    }
  }
  await revisarInicioAlArrancar();
}
arrancar();
