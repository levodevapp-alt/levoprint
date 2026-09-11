// ============================================================
// LevoPrint · Agente de impresión v1.4 (RENDER EN SERVIDOR + respaldo local)  ⚡ <Levodev.app />
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
const DEVICE = process.env.LEVO_DEVICE || process.env.KOMO_DEVICE;
const PREFIJO = (process.env.LEVO_PREFIJO || 'komo').trim();
const MODO_CONSOLA = ((process.env.LEVO_MODO || process.env.KOMO_MODO) || '') === 'consola';
const INTERVALO_MS = 2000;
const ANCHO = parseInt(process.env.LEVO_ANCHO || '48', 10) || 48; // columnas típicas de térmica 58mm

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

if (!URL_BASE || !ANON || !DEVICE || /TU-PROYECTO|PEGA-AQUI/.test(URL_BASE + ANON + DEVICE)) {
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

async function refrescarConfig() {
  const cfg = await rpc(`${PREFIJO}_agente_config`, { device: DEVICE });
  estaciones = new Map((cfg.estaciones || []).map((e) => [e.id, e]));
  console.log(`[cfg] ${estaciones.size} estaciones:`,
    [...estaciones.values()].map((e) => `${e.nombre}@${e.ip || 'SIN-IP'}:${e.puerto}`).join(' · '));
}

async function ciclo() {
  try {
    if (cicloConfig++ % 30 === 0) await refrescarConfig(); // config cada ~60s
    const r = await rpc(`${PREFIJO}_print_tomar`, { device: DEVICE, limite: 10 });
    for (const job of r.jobs || []) {
      const est = estaciones.get(job.estacion);
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
      } catch (e) {
        console.error(`[err] job ${job.id}: ${e.message}`);
        await rpc(`${PREFIJO}_print_marcar`, { device: DEVICE, id: job.id, ok: false, error: e.message });
      }
    }
  } catch (e) {
    console.error('[ciclo]', e.message);
  } finally {
    setTimeout(ciclo, INTERVALO_MS);
  }
}

console.log('LevoPrint agente de impresion v1.4 (render en servidor) — <Levodev.app />');
console.log(MODO_CONSOLA ? 'MODO CONSOLA (sin impresoras reales)' : 'Modo impresión real');
ciclo();
