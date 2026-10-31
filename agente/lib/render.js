// ============================================================
// LevoPrint · render ESC/POS (F2: sacado de index.js sin cambiar un byte)
// ------------------------------------------------------------
// [F2] Antes vivia dentro de index.js con ANCHO global. Ahora es una fabrica
// por ancho: crearRender(48) / crearRender(64). El cuerpo es COPIA LITERAL del
// render de la rama kuti (b8b1517); test/render.test.js lo compara byte a byte
// con los dorados generados por el index.js original (test/generar-dorados.js).
// La misma salida debe dar core/escpos (levodev-modules) para el respaldo WebUSB.
// No editar el formato aqui sin regenerar los dorados A PROPOSITO.
// ============================================================
'use strict';

function crearRender(ANCHO) {
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
  
  function firma(pl){
    const app=(pl&&pl.app)||process.env.LEVO_APP||"";
    const lema=(pl&&pl.lema)||process.env.LEVO_LEMA||"";
    let f=CMD.centro;
    if(app) f+=CMD.negritaOn+String(app).toUpperCase()+"\n"+CMD.negritaOff;
    if(lema) f+="\x1b\x21\x00"+lema+"\n";
    f+="\x1b\x21\x00<Levodev.app />\n";
    return f;
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
  
  function renderBase(job) {
    if (job.tipo === 'CARTA_QR') return renderCartaQr(job.payload);
    if (job.tipo === 'COMANDA') return renderComanda(job.payload);
    if (job.tipo === 'PRECUENTA') return renderPrecuenta(job.payload);
    if (job.tipo === 'TICKET') return renderTicket(job.payload);
    if (job.tipo === 'CPE') return renderCpe(job.payload);
    // [kuti] Corte con lineas ya formateadas por la base (KOMO/KIPU: JSON como antes).
    if (job.tipo === 'CIERRE' && Array.isArray((job.payload || {}).lineas)) return renderCierre(job.payload);
    if (job.tipo === 'PRUEBA') return CMD.init + CMD.centro + 'PRUEBA LEVOPRINT OK\n' + CMD.corte;
    return CMD.init + JSON.stringify(job.payload, null, 1) + CMD.corte;
  }

  return { render, renderBase, CMD, qrEscPos, numeroALetras, denomCpe };
}

// Cache por ancho: el ancho cambia rara vez (boton 58/80 mm de la ventana).
const _cache = new Map();
function renderPara(ancho) {
  const k = Number(ancho) || 48;
  if (!_cache.has(k)) _cache.set(k, crearRender(k));
  return _cache.get(k);
}

module.exports = { crearRender, renderPara };
