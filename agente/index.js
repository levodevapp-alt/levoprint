// ============================================================
// LevoPrint · Agente de impresión v1.6 (ventana visual + emparejamiento por código + render servidor)  ⚡ <Levodev.app />
// Corre en la PC del local. Poll cada 2s a komo_print_tomar,
// renderiza ESC/POS y lo manda a la IP:puerto de cada estación.
// Se empaqueta a LevoPrint.exe (Node SEA). El dueño solo edita
// "levoprint.txt" (junto al .exe) con 3 datos:
//   LEVO_URL=https://<ref>.supabase.co
//   LEVO_ANON=<anon key>
//   LEVO_DEVICE=<token uuid del dispositivo AGENTE>
//   LEVO_MODO=consola   (opcional: imprime a consola, sin impresora)
// Sin dependencias: Node >= 18 (fetch + net nativos).
// ============================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

// --- ¿corro como .exe (SEA) o como `node index.js`? ---
// Empaquetado como Single Executable App, `__dirname` no apunta a una
// carpeta real: la config debe leerse JUNTO AL .exe (dirname del propio
// ejecutable). En desarrollo (`node index.js`) sí vale `__dirname`.
let esExe = false;
try { esExe = require('node:sea').isSea(); } catch { esExe = false; }
const BASE_DIR = esExe ? path.dirname(process.execPath)
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
    for (const linea of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(linea)) continue;              // comentarios y vacias
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
})();

const URL_BASE = process.env.LEVO_URL || process.env.KOMO_URL;
const ANON = process.env.LEVO_ANON || process.env.KOMO_ANON;
let DEVICE = process.env.LEVO_DEVICE || process.env.KOMO_DEVICE;   // let: el canje del codigo lo completa
const PREFIJO = (process.env.LEVO_PREFIJO || 'komo').trim();
// [emparejar] Si el "levoprint.txt" trae LEVO_CODIGO (lo pone el boton
// "Descargar" de la consola) y AUN no hay device, se canjea una vez: el
// agente pide su token al servidor y lo guarda. Asi el dueno no pega el
// token a mano — solo instala. url/anon (publicos) vienen en el txt.
const CODIGO = (process.env.LEVO_CODIGO || '').trim();
const MODO_CONSOLA = ((process.env.LEVO_MODO || process.env.KOMO_MODO) || '') === 'consola';
const INTERVALO_MS = 2000;
let ANCHO = parseInt(process.env.LEVO_ANCHO || '48', 10) || 48; // columnas típicas de térmica 58mm (48) u 80mm (64/72)
// [ventana] LEVO_SINVENTANA=1 (o corriendo como servicio de Windows): no abrir
// navegador, pero la mini-GUI web se sigue sirviendo igual (soporte remoto).
const SIN_VENTANA = /^(1|true|si|s[ií])$/i.test(String(process.env.LEVO_SINVENTANA || ''));
const PUERTO_GUI_BASE = parseInt(process.env.LEVO_PUERTO_GUI || '9110', 10) || 9110;

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

async function rpc(fn, p) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    signal: AbortSignal.timeout(12000),
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p }),
  });
  if (!r.ok) throw new Error(`${fn} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// --- ESC/POS ---
const ESC = '\x1b', GS = '\x1d';
const CMD = {
  init: ESC + '@',
  centro: ESC + 'a\x01', izq: ESC + 'a\x00',
  negritaOn: ESC + 'E\x01', negritaOff: ESC + 'E\x00',
  grande: GS + '!\x11', normal: GS + '!\x00',
  corte: '\n\n\n' + GS + 'V\x00',
};
const linea = (c = '-') => c.repeat(ANCHO) + '\n';
const fila = (izq, der) => {
  izq = String(izq); der = String(der);
  const esp = Math.max(1, ANCHO - izq.length - der.length);
  return izq + ' '.repeat(esp) + der + '\n';
};
const money = (n) => 'S/ ' + Number(n).toFixed(2);

function renderComanda(pl) {
  const titulo = pl.correccion ? '*** CORRECCION ***' : 'COMANDA';
  let t = CMD.init + CMD.centro + CMD.grande + titulo + '\n' + CMD.normal;
  t += CMD.grande + `MESA ${pl.mesa}\n` + CMD.normal + CMD.izq + linea('=');
  t += fila(`Mozo: ${pl.mozo || '-'}`, pl.hora || '');
  if (pl.ronda) t += fila(`Ronda ${pl.ronda}`, '');
  t += linea('=');
  if (pl.mensaje) t += CMD.negritaOn + CMD.grande + pl.mensaje + '\n' + CMD.normal + CMD.negritaOff + linea();
  for (const it of pl.items || []) {
    t += CMD.negritaOn + `${fmtCant(it.cantidad)} x ${it.nombre}\n` + CMD.negritaOff;
    if (it.nota) t += `   >> ${it.nota}\n`;
  }
  if (pl.nota) t += linea() + `NOTA: ${pl.nota}\n`;
  t += linea('=') + CMD.centro + firma(pl) + CMD.corte;
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

// [F2] Ticket interno de cobro (no es comprobante)
function renderTicket(pl) {
  // Retail (KIPU) no manda mesa; restaurante (KOMO) sí. Un solo template
  // sirve a ambos: con negocio + nota para la tienda, con mesa/mozo para el resto.
  const retail = !pl.mesa;
  let t = CMD.init + CMD.centro;
  if (pl.negocio) t += CMD.negritaOn + CMD.grande + String(pl.negocio).toUpperCase() + '\n' + CMD.normal + CMD.negritaOff;
  t += CMD.grande + (retail ? 'VENTA\n' : 'COBRADO\n') + CMD.normal;
  if (!retail) t += CMD.grande + 'MESA ' + (pl.mesa || '-') + '\n' + CMD.normal;
  t += CMD.izq + linea('=');
  if (pl.nota) t += 'Nota: ' + pl.nota + '\n';
  const quien = pl.vendedor || pl.mozo || '';
  t += fila(quien ? ((retail ? 'Atendio: ' : 'Mozo: ') + quien) : '', pl.hora || '');
  t += linea();
  for (const it of pl.items || []) {
    t += fila((fmtCant(it.cantidad) + ' ' + it.nombre).slice(0, ANCHO - 9), money(it.cantidad * it.precio));
  }
  t += linea('=') + CMD.negritaOn + fila('TOTAL', money(pl.total)) + CMD.negritaOff;
  for (const p of pl.pagos || []) t += fila('  ' + p.medio, money(p.monto));
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

function firma(pl){
  const app=(pl&&pl.app)||process.env.LEVO_APP||"";
  const lema=(pl&&pl.lema)||process.env.LEVO_LEMA||"";
  let f=CMD.centro;
  if(app) f+=CMD.negritaOn+String(app).toUpperCase()+"\n"+CMD.negritaOff;
  if(lema) f+="\x1b\x21\x00"+lema+"\n";
  f+="\x1b\x21\x00<Levodev.app />\n";
  return f;
}

function render(job) {
  if (job.tipo === 'CARTA_QR') return renderCartaQr(job.payload);
  if (job.tipo === 'COMANDA') return renderComanda(job.payload);
  if (job.tipo === 'PRECUENTA') return renderPrecuenta(job.payload);
  if (job.tipo === 'TICKET') return renderTicket(job.payload);
  if (job.tipo === 'CPE') return renderCpe(job.payload);
  if (job.tipo === 'PRUEBA') return CMD.init + CMD.centro + 'PRUEBA LEVOPRINT OK\n' + CMD.corte;
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

// Render SERVIDOR: el ticket se arma en la edge function `<prefijo>-print`
// y aquí solo se imprime. Así los cambios de formato/firma se despliegan
// sin re-instalar el agente. Si el endpoint falla, cae al render local.
async function renderRemoto(job) {
  const r = await fetch(`${URL_BASE}/functions/v1/${PREFIJO}-print`, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: job.tipo, payload: job.payload, ancho: ANCHO }),
  });
  if (!r.ok) throw new Error('render remoto HTTP ' + r.status);
  const j = await r.json();
  if (!j || j.ok !== true || !j.esc) throw new Error('render remoto sin esc');
  return Buffer.from(j.esc, 'base64').toString('binary');
}

// --- ciclo principal ---
let estaciones = new Map(); // id -> {nombre, ip, puerto}
let cicloConfig = 0;

// [gui] Estado en vivo que consume la mini-GUI web (GET /estado). Nada de
// esto altera el ciclo de impresion: solo se lee/escribe para informar.
const guiEstado = {
  imprimiendo: false,       // true mientras se procesa un job ahora mismo
  ultimoError: null,        // { mensaje, ts } del ultimo job o ciclo fallido
  ultimoOk: null,           // ts del ultimo job impreso ok
  ultimaSync: null,         // ts de la ultima vez que refrescarConfig() respondio
};

async function refrescarConfig() {
  const cfg = await rpc(`${PREFIJO}_agente_config`, { device: DEVICE });
  estaciones = new Map((cfg.estaciones || []).map((e) => [e.id, e]));
  guiEstado.ultimaSync = Date.now();
  console.log(`[cfg] ${estaciones.size} estaciones:`,
    [...estaciones.values()].map((e) => `${e.nombre}@${e.ip || 'SIN-IP'}:${e.puerto}`).join(' · '));
}

async function ciclo() {
  try {
    if (cicloConfig++ % 30 === 0) await refrescarConfig(); // config cada ~60s
    const r = await rpc(`${PREFIJO}_print_tomar`, { device: DEVICE, limite: 10 });
    for (const job of r.jobs || []) {
      const est = estaciones.get(job.estacion);
      guiEstado.imprimiendo = true;
      try {
        // Render en el SERVIDOR (formato siempre al día); respaldo local si cae.
        let texto;
        try { texto = await renderRemoto(job); }
        catch (_) { texto = render(job); }
        if (MODO_CONSOLA || !est || !est.ip) {
          console.log(`\n--- JOB ${job.id} (${job.tipo}) -> ${est ? est.nombre : 'SIN ESTACION'} ---`);
          console.log(texto.replace(/[\x00-\x1f]/g, '').trim());
          if (!MODO_CONSOLA && (!est || !est.ip)) throw new Error('estacion sin IP');
        } else {
          await imprimirRaw(est.ip, est.puerto || 9100, texto);
          console.log(`[ok] job ${job.id} ${job.tipo} -> ${est.nombre} (${est.ip})`);
        }
        await rpc(`${PREFIJO}_print_marcar`, { device: DEVICE, id: job.id, ok: true });
        guiEstado.ultimoOk = Date.now();
      } catch (e) {
        console.error(`[err] job ${job.id}: ${e.message}`);
        guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
        await rpc(`${PREFIJO}_print_marcar`, { device: DEVICE, id: job.id, ok: false, error: e.message });
      } finally {
        guiEstado.imprimiendo = false;
      }
    }
  } catch (e) {
    console.error('[ciclo]', e.message);
    guiEstado.ultimoError = { mensaje: e.message, ts: Date.now() };
  } finally {
    setTimeout(ciclo, INTERVALO_MS);
  }
}

// [emparejar] Canjea un codigo (el de LEVO_CODIGO al arrancar, o el que el
// dueno pega en la mini-GUI): pide el token del agente al servidor (canjear
// es de un uso) y lo persiste en levoprint.txt, para que la proxima vez que
// abra el programa ya arranque solo. Devuelve {ok,...} para poder responder
// tanto en consola como en el endpoint POST /vincular.
async function canjearCodigo(codigoIn) {
  const cod = String(codigoIn || CODIGO || '').trim();
  if (!cod) return { ok: false, error: 'SIN_CODIGO', mensaje: 'Falta el codigo.' };
  if (DEVICE) return { ok: false, error: 'YA_VINCULADO', mensaje: 'Este agente ya esta vinculado.' };
  if (!URL_BASE || !ANON) return { ok: false, error: 'FALTA_URL_ANON', mensaje: 'Falta LEVO_URL/LEVO_ANON en levoprint.txt.' };
  console.log('Emparejando con el codigo ' + cod + '...');
  let d;
  try {
    d = await rpc(`${PREFIJO}_estacion_codigo_canjear`, { codigo: cod });
  } catch (e) {
    console.error('No se pudo emparejar (revisa tu internet): ' + e.message);
    return { ok: false, error: 'RED', mensaje: 'No se pudo emparejar (revisa tu internet): ' + e.message };
  }
  if (!d || d.ok !== true) {
    const err = (d && d.error) || 'ERROR';
    const msg = {
      CODIGO_INVALIDO: 'El codigo no es valido.',
      CODIGO_VENCIDO: 'El codigo vencio (dura 15 min). Genera uno nuevo en tu consola (Estaciones).',
      CODIGO_USADO: 'Ese codigo ya se uso. Genera uno nuevo en tu consola (Estaciones).'
    }[err] || ('No se pudo emparejar: ' + err);
    console.error(msg);
    return { ok: false, error: err, mensaje: msg };
  }
  DEVICE = d.device;
  process.env.LEVO_DEVICE = d.device;
  try {
    const ruta = path.join(BASE_DIR, 'levoprint.txt');
    let txt = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
    txt = txt.replace(/^[ \t]*LEVO_CODIGO[ \t]*=.*$/gim, '# LEVO_CODIGO usado');
    if (/^[ \t]*LEVO_DEVICE[ \t]*=/im.test(txt)) txt = txt.replace(/^[ \t]*LEVO_DEVICE[ \t]*=.*$/im, 'LEVO_DEVICE=' + d.device);
    else txt += (txt.endsWith('\n') ? '' : '\r\n') + 'LEVO_DEVICE=' + d.device + '\r\n';
    fs.writeFileSync(ruta, txt, 'utf8');
  } catch (_) { /* carpeta de solo lectura: queda en memoria esta sesion */ }
  console.log('Emparejado como: ' + (d.nombre || 'estacion') + '. Listo.');
  return { ok: true, nombre: d.nombre };
}

// Persiste LEVO_ANCHO en levoprint.txt (mismo patron que LEVO_DEVICE arriba).
function persistirAncho(valor) {
  try {
    const ruta = path.join(BASE_DIR, 'levoprint.txt');
    let txt = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
    if (/^[ \t]*LEVO_ANCHO[ \t]*=/im.test(txt)) txt = txt.replace(/^[ \t]*LEVO_ANCHO[ \t]*=.*$/im, 'LEVO_ANCHO=' + valor);
    else txt += (txt.endsWith('\n') || txt === '' ? '' : '\r\n') + 'LEVO_ANCHO=' + valor + '\r\n';
    fs.writeFileSync(ruta, txt, 'utf8');
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
  const listaEst = [...estaciones.values()].map((e) => ({
    id: e.id, nombre: e.nombre, ip: e.ip || null, puerto: e.puerto || 9100,
  }));
  let semaforo = 'sin_vincular';
  if (sinUrlAnon) semaforo = 'sin_configurar';
  else if (!vinculado) semaforo = 'sin_vincular';
  else if (guiEstado.imprimiendo) semaforo = 'imprimiendo';
  else if (guiEstado.ultimoError && (!guiEstado.ultimoOk || guiEstado.ultimoError.ts > guiEstado.ultimoOk)) semaforo = 'sin_impresora';
  else semaforo = 'conectado';
  return {
    ok: true,
    version: '1.6',
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
  };
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
      <input id="codigo" type="text" maxlength="8" placeholder="CODIGO DE 8 CARACTERES">
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

    <footer>&lt;Levodev.app /&gt;</footer>
  </div>

<script>
async function j(url, opts) {
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}
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
    conectado: ['ok', 'Conectado — listo para imprimir'],
  };
  const [clase, texto] = mapa[e.semaforo] || ['info', 'Estado desconocido'];
  sem.classList.add(clase);
  semTxt.textContent = texto;

  document.getElementById('vinculoBox').style.display = (e.vinculado || e.sinUrlAnon) ? 'none' : 'block';

  const box = document.getElementById('estacionesBox');
  if (!e.estaciones || !e.estaciones.length) {
    box.innerHTML = e.vinculado ? '<div class="fila muted">Sin estaciones asignadas todavia.</div>' : '';
  } else {
    box.innerHTML = e.estaciones.map(function (est) {
      const ip = est.ip ? (est.ip + ':' + est.puerto) : 'SIN IP — configura la IP en tu consola web';
      return '<div class="fila"><span>' + est.nombre + '</span><span class="muted">' + ip + '</span></div>';
    }).join('');
  }

  document.getElementById('anchoTexto').textContent = e.ancho + ' columnas (' + (e.ancho > 56 ? '80mm' : '58mm') + ')';
  document.getElementById('btnPrueba').disabled = !e.vinculado;
}

document.getElementById('btnVincular').addEventListener('click', async function () {
  const codigo = document.getElementById('codigo').value.trim();
  const msg = document.getElementById('msgVinculo');
  if (!codigo) { msg.textContent = 'Escribe el codigo.'; msg.className = 'msg err'; return; }
  msg.textContent = 'Vinculando...'; msg.className = 'msg';
  const r = await j('/vincular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: codigo }) });
  if (r && r.ok) { msg.textContent = 'Vinculado como ' + (r.nombre || 'estacion') + '.'; msg.className = 'msg ok'; }
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
  if (faltaConfig()) return responderJson(res, 400, { ok: false, error: 'SIN_VINCULAR', mensaje: 'Primero vincula el agente.' });
  const body = await leerBodyJson(req);
  const est = body.estacion ? estaciones.get(body.estacion) : [...estaciones.values()][0];
  const texto = render({ tipo: 'PRUEBA', payload: {} });
  try {
    if (MODO_CONSOLA || !est || !est.ip) {
      console.log('[prueba] ' + texto.replace(/[\x00-\x1f]/g, '').trim());
      return responderJson(res, 200, {
        ok: true,
        aviso: !est ? 'Sin estaciones asignadas: se mostro en consola.'
              : !est.ip ? 'Sin IP configurada: se mostro en consola. Configura la IP en tu consola web.'
              : 'Modo consola: se mostro en consola.',
      });
    }
    await imprimirRaw(est.ip, est.puerto || 9100, texto);
    guiEstado.ultimoOk = Date.now();
    return responderJson(res, 200, { ok: true, aviso: 'Prueba enviada a ' + est.nombre + ' (' + est.ip + ').' });
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
    ciclo(); // recien ahora hay DEVICE: arranca el loop que arrancar() no pudo iniciar
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
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(paginaHtml());
    }
    if (req.method === 'GET' && url === '/estado') return responderJson(res, 200, estadoActual());
    if (req.method === 'POST' && url === '/prueba') return void manejarPrueba(req, res);
    if (req.method === 'POST' && url === '/vincular') return void manejarVincular(req, res);
    if (req.method === 'POST' && url === '/ancho') return void manejarAncho(req, res);
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

async function arrancar() {
  await canjearCodigo();
  if (faltaUrlAnon()) { abortarSinConfig(); return; }
  console.log('LevoPrint agente de impresion v1.6 (ventana visual + emparejamiento por codigo) — <Levodev.app />');
  console.log(MODO_CONSOLA ? 'MODO CONSOLA (sin impresoras reales)' : 'Modo impresión real');
  iniciarGui();
  if (!faltaConfig()) ciclo();
  else console.log('Falta vincular: abre la ventana de LevoPrint (o entra tu codigo por /vincular) para terminar la configuracion.');
}
arrancar();
