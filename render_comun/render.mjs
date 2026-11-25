// @ts-nocheck
// ============================================================
// LevoDev · RENDER ESC/POS COMÚN de LevoPrint (F5, 4-nov-2026) — UNA fuente para KOMO, KIPU y KUTI
// ------------------------------------------------------------
// Superconjunto de los render de las Edges komo-print / kipu-print (familia «pos») y kuti-print (familia «kuti»):
// cada papel sale BYTE A BYTE igual que en la Edge de su app (fixtures en core/print/fixtures/*.json + .hex,
// npm run ensayo:print-render). Lo que una Edge no sabía dibujar ahora lo dibujan todas (COMANDA, PRECUENTA, CIERRE,
// TURNO); lo que sí sabía no cambia. Las diferencias reales van por familia:
//   pos  : TICKET de resto/retail (mesa, mozo/vendedor), sello REIMPRESION / ATRASADA, fila sin recorte, montos sin
//          || 0, CPE con nombre recortado, «SON:» con céntimos por resta, CARTA_QR «catalogo», PRUEBA sin estación.
//   kuti : TICKET nota de venta (profesional, propinas aparte, ALQUILER DE SILLA), sello COPIA (copia|reimpresion),
//          fila que recorta la izquierda, listas con tope de 500, «SON:» en céntimos enteros, CARTA_QR «carta de
//          servicios», PRUEBA con la estación.
// [LP-U1R · 25-nov] Al día con lo vivo: «ICBPER (bolsas)» del CPE (KS-09), leyenda «Medios de pago: al contar la caja»
// con montosOcultos (caja_captor_comun, TICKET y CPE) y el ticket de turno de vendedor de KIPU (VEN-KIPU F1). Las 5
// apps (KAMA y KAWA, familia pos). 90 fixtures = Edges VIVAS byte a byte.
// Puro (sin Deno ni red, solo node:buffer): lo usan la Edge generada (módulo levoprint_edge → supabase/functions/
// <prefijo>-print/render.ts, copia exacta de este archivo) y las pruebas con Node. El agente .exe copiará esta
// fuente con verificación de hash (pendiente, agente B).
// Uso: const r = crearRender({ app: 'KOMO' }); r.render(tipo, payload, ancho, imagen) → string latin1;
//      r.renderBase64(…) → base64 (lo que no cabe en latin1 sale «?»).
// LevoDev
// ============================================================
import { Buffer } from 'node:buffer'

const ESC = '\x1b'; const GS = '\x1d'
const CMD = {
  init: ESC + '@',
  centro: ESC + 'a\x01',
  izq: ESC + 'a\x00',
  negritaOn: ESC + 'E\x01',
  negritaOff: ESC + 'E\x00',
  grande: GS + '!\x11',
  normal: GS + '!\x00',
  enorme: GS + '!\x22',
  corte: '\n\n\n' + GS + 'V\x00'
}
const LEMA = 'Tu negocio, inteligente y bajo control.'
// Isotipo D2 Yupana 64x64 en 1 bit (tools/marca/isotipo_termico.mjs): GS v 0 m=0, 8 bytes x 64 filas.
const ISOTIPO_B64 = 'P/+AAAAAD8B//8AAAAB/8P//4AAAAP/4///gAAAB//z//+AAAAH//v//4AAAA//+///gAAAD/////+AAAAf/////4AAAB//////gAAAH/////+AAAAf/////4AAAB//////gAAAD//7//+AAAAP//v//4AAAAf/+///gAAAB//z//+AAAAD/+H//wAAAAD/gP/+AAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAB//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/+A//8B//x//8H//4P//v//4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f//3//wf//g//+P/+A//8B//w='
const isotipoEscPos = () => ESC + 'J\x08' + GS + 'v0\x00\x08\x00\x40\x00' + Buffer.from(ISOTIPO_B64, 'base64').toString('binary') + ESC + 'J\x06'
export const MAX_FILAS = 500

function qrEscPos (texto, tam = 5) {
  const data = Buffer.from(String(texto || ''), 'utf8')
  const len = data.length + 3
  const pL = String.fromCharCode(len & 0xff); const pH = String.fromCharCode((len >> 8) & 0xff)
  return GS + '(k\x04\x00\x31\x41\x32\x00' +
    GS + '(k\x03\x00\x31\x43' + String.fromCharCode(tam) +
    GS + '(k\x03\x00\x31\x45\x31' +
    GS + '(k' + pL + pH + '\x31\x50\x30' + data.toString('binary') +
    GS + '(k\x03\x00\x31\x51\x30'
}
const fmtCant = (n) => (Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(3))
const mayus = (s) => s.toUpperCase().replace(/[^\x00-\xff]/g, '?')

const U_ = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE']
const D_ = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
const C_ = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']
function centenas (n) {
  if (n === 100) return 'CIEN'
  let t = ''; const c = Math.floor(n / 100); const r = n % 100; if (c) t += C_[c] + ' '
  if (r <= 20) t += U_[r]; else { const d = Math.floor(r / 10); const u = r % 10; if (d === 2) t += (u ? 'VEINTI' + U_[u] : 'VEINTE'); else t += D_[d] + (u ? ' Y ' + U_[u] : '') }
  return t.trim()
}
function seccion (n) {
  let t = ''; const mill = Math.floor(n / 1000000); n %= 1000000
  if (mill) t += (mill === 1 ? 'UN MILLON ' : centenas(mill) + ' MILLONES ')
  const mil = Math.floor(n / 1000); n %= 1000
  if (mil) t += (mil === 1 ? 'MIL ' : centenas(mil) + ' MIL ')
  if (n) t += centenas(n)
  return t.trim() || 'CERO'
}
function denomCpe (tipo) {
  const t = String(tipo || '').toUpperCase()
  if (t.includes('FACTURA')) return 'FACTURA ELECTRONICA'
  if (t.includes('BOLETA')) return 'BOLETA DE VENTA ELECTRONICA'
  if (t.includes('CREDITO')) return 'NOTA DE CREDITO ELECTRONICA'
  if (t.includes('DEBITO')) return 'NOTA DE DEBITO ELECTRONICA'
  return t || 'COMPROBANTE'
}
export function envolver (texto, ancho) {
  ancho = Math.max(1, ancho)
  const out = []
  let l = ''
  for (let w of String(texto ?? '').split(/\s+/).filter(Boolean)) {
    while (w.length > ancho) { if (l) { out.push(l); l = '' } out.push(w.slice(0, ancho)); w = w.slice(ancho) }
    if (!w) continue
    if (!l) l = w
    else if (l.length + 1 + w.length <= ancho) l += ' ' + w
    else { out.push(l); l = w }
  }
  if (l) out.push(l)
  return out
}

export function crearRender ({ app } = {}) {
  const APP = String(app || '').toUpperCase()
  if (!/^[A-Z]{2,12}$/.test(APP)) throw new Error('crearRender: app inválida')
  const KUTI = APP === 'KUTI'
  let ANCHO = 48
  let IMAGEN = true
  const linea = (c = '-') => c.repeat(ANCHO) + '\n'
  // pos: sin recorte · kuti: la izquierda se recorta, el monto nunca
  const fila = (izq, der) => {
    const d = KUTI ? String(der ?? '') : String(der)
    let i = KUTI ? String(izq ?? '') : String(izq)
    if (KUTI && i.length + d.length + 1 > ANCHO) i = i.slice(0, Math.max(0, ANCHO - d.length - 1))
    const esp = Math.max(1, ANCHO - i.length - d.length)
    return i + ' '.repeat(esp) + d + '\n'
  }
  const money = (n) => 'S/ ' + (KUTI ? Number(n || 0) : Number(n)).toFixed(2)
  // [LP-U1R · QA BAJO-3] TOTAL ausente o inválido (null, '', texto, NaN, Infinity): «--» en vez de «S/ NaN» (o de un
  // «S/ 0.00» que parece real) y el CPE omite «SON:». «—» no cabe en latin1 (saldría «?»): se usa «--».
  const totalOk = (x) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)))
  const montoTotal = (x) => (totalOk(x) ? money(x) : '--')
  // [LP-U1R · QA BAJO-2] Copia a ciegas: con montosOcultos NO sale ningún pago ni propina aunque el payload los traiga
  // (defensa en profundidad: el servidor ya los manda vacíos).
  const pagosDe = (pl) => (pl.montosOcultos ? [] : lista(pl.pagos))
  const lista = (x) => (KUTI ? (Array.isArray(x) ? x.slice(0, MAX_FILAS) : []) : (x || []))
  function numeroALetras (num) {
    if (KUTI) {
      const cent = Math.round(Number(num || 0) * 100)
      return seccion(Math.floor(cent / 100)) + ' CON ' + String(cent % 100).padStart(2, '0') + '/100 SOLES'
    }
    const e = Math.floor(Number(num || 0)); const cent = Math.round((Number(num || 0) - e) * 100)
    return seccion(e) + ' CON ' + String(cent).padStart(2, '0') + '/100 SOLES'
  }
  function pieMarca (ancho, imagen = true) {
    const lema = ancho >= 40 ? LEMA + '\n' : 'Tu negocio, inteligente\ny bajo control.\n'
    const quien = 'Hecho con ' + APP + ' - levodev.app'
    return (imagen ? isotipoEscPos() : '') + (quien.length > ancho ? quien.replace(' - ', '\n') : quien) + '\n' + lema
  }
  const firma = (pl) => CMD.centro + '\x1b\x21\x00' + pieMarca(ANCHO, IMAGEN && !(pl && pl.sinImagen))
  function negocioGrande (nombre) {
    const mitad = Math.floor(ANCHO / 2)
    let out = ''; let l = ''
    const sale = (s) => { out += CMD.negritaOn + (s.length <= mitad ? CMD.grande : '') + s + '\n' + CMD.normal + CMD.negritaOff }
    for (const w of mayus(String(nombre ?? '')).split(/\s+/).filter(Boolean)) {
      if (w.length > mitad) { if (l) { sale(l); l = '' } for (let i = 0; i < w.length; i += Math.max(1, ANCHO)) sale(w.slice(i, i + ANCHO)); continue }
      if (l && l.length + 1 + w.length <= mitad) l += ' ' + w; else { if (l) sale(l); l = w }
    }
    if (l) sale(l)
    return out
  }

  // ---- COMANDA (cocina/estación, sin marca) ----
  const alto = GS + '!\x01'
  function renderComanda (pl) {
    let t = CMD.init + CMD.centro
    t += pl.correccion ? CMD.negritaOn + CMD.grande + '*** CORRECCION ***\n' + CMD.normal + CMD.negritaOff : CMD.negritaOn + 'COMANDA\n' + CMD.negritaOff
    const mesa = 'MESA ' + (pl.mesa || '-')
    t += CMD.negritaOn + (mesa.length * 3 <= ANCHO ? GS + '!\x22' : mesa.length * 2 <= ANCHO ? CMD.grande : '') + mesa + '\n' + CMD.normal + CMD.negritaOff
    t += CMD.izq + linea('=')
    t += CMD.negritaOn + fila('Mozo: ' + (pl.mozo || '-'), pl.hora || '') + CMD.negritaOff
    if (pl.ronda) t += fila('Ronda ' + pl.ronda, '')
    t += linea('=')
    if (pl.mensaje) t += CMD.negritaOn + CMD.grande + pl.mensaje + '\n' + CMD.normal + CMD.negritaOff + linea()
    for (const it of lista(pl.items)) {
      const cab = fmtCant(it.cantidad) + ' x '
      const ls = envolver(it.nombre, Math.max(8, ANCHO - cab.length));
      (ls.length ? ls : ['(sin nombre)']).forEach((l, i) => {
        t += CMD.negritaOn + alto + (i === 0 ? cab : ' '.repeat(cab.length)) + l + '\n' + CMD.normal + CMD.negritaOff
      })
      if (it.nota) for (const l of envolver(it.nota, ANCHO - 6)) t += CMD.negritaOn + '   >> ' + l + CMD.negritaOff + '\n'
    }
    if (pl.nota) { t += linea(); for (const l of envolver('NOTA: ' + pl.nota, ANCHO)) t += CMD.negritaOn + l + CMD.negritaOff + '\n' }
    t += linea('=') + CMD.corte
    return t
  }
  function renderPrecuenta (pl) {
    let t = CMD.init + CMD.centro + CMD.grande + 'PRECUENTA\n' + CMD.normal
    t += `MESA ${pl.mesa}\n`
    if (pl.cuenta && pl.cuenta.de) t += CMD.negritaOn + `CUENTA ${pl.cuenta.n} de ${pl.cuenta.de}\n` + CMD.negritaOff
    t += CMD.izq + linea('=')
    t += fila(`Mozo: ${pl.mozo || '-'}`, pl.hora || '')
    t += linea()
    for (const it of lista(pl.items)) t += fila(`${fmtCant(it.cantidad)} ${it.nombre}`.slice(0, ANCHO - 9), money(it.cantidad * it.precio))
    t += linea('=') + CMD.negritaOn + fila('TOTAL', montoTotal(pl.total)) + CMD.negritaOff
    t += linea('=') + CMD.centro
    if (pl.qr) t += qrEscPos(pl.qr) + '\n'
    t += 'NO ES COMPROBANTE DE PAGO\n' + firma(pl) + CMD.corte
    return t
  }
  function renderCartaQr (pl) {
    let t = CMD.init + CMD.centro + CMD.negritaOn + CMD.grande + (pl.titulo || '') + '\n' + CMD.normal + CMD.negritaOff
    t += '\x1b\x21\x00' + (pl.sub || (KUTI ? 'Escanea nuestra carta de servicios' : 'Escanea nuestro catalogo')) + '\n\n'
    if (pl.url) t += qrEscPos(pl.url, 8) + '\n'
    t += '\x1b\x21\x00' + (pl.url || '') + '\n'
    t += firma(pl) + CMD.corte
    return t
  }
  // TICKET familia pos: resto (con mesa) o retail (sin mesa)
  function renderTicketPos (pl) {
    const retail = !pl.mesa
    let t = CMD.init + CMD.centro
    if (pl.negocio) t += negocioGrande(pl.negocio)
    t += CMD.grande + (retail ? 'VENTA\n' : 'COBRADO\n') + CMD.normal
    if (!retail) t += CMD.grande + 'MESA ' + (pl.mesa || '-') + '\n' + CMD.normal
    t += CMD.izq + linea('=')
    if (pl.nota) t += 'Nota: ' + pl.nota + '\n'
    // [VEN-KIPU F1 · 12-nov] Ticket de un turno de vendedor: si salió por Caja porque su impresora falló, se dice arriba; y
    // lleva el código del turno y el local. Sin turno (lo de siempre, y KOMO nunca lo manda) no se imprime nada de esto.
    if (pl.respaldo && pl.avisoRespaldo) t += CMD.negritaOn + '(' + String(pl.avisoRespaldo) + ')' + CMD.negritaOff + '\n'
    if (pl.turno) t += fila('Turno ' + String(pl.turno), String(pl.local || '').slice(0, Math.max(0, ANCHO - 12)))
    const quien = pl.vendedor || pl.mozo || ''
    t += fila(quien ? ((retail ? 'Atendio: ' : 'Mozo: ') + quien) : '', pl.hora || '')
    t += linea()
    for (const it of lista(pl.items)) t += fila((fmtCant(it.cantidad) + ' ' + it.nombre).slice(0, ANCHO - 9), money(it.cantidad * it.precio))
    t += linea('=') + CMD.negritaOn + fila('TOTAL', montoTotal(pl.total)) + CMD.negritaOff
    for (const p of pagosDe(pl)) t += fila('  ' + p.medio, money(p.monto))
    // [caja_captor_comun · KCAP-PRINT · 18-nov] Reimpresión a ciegas de un papel ajeno: el servidor manda sin pagos.
    // Payloads viejos no traen la marca y salen igual que antes.
    if (pl.montosOcultos) t += 'Medios de pago: al contar la caja\n'
    t += linea('=') + CMD.centro + 'NO ES COMPROBANTE DE PAGO\n'
    t += firma(pl) + CMD.corte
    return t
  }
  // TICKET familia kuti: nota de venta (servicios con su profesional; propinas aparte)
  function renderTicketKuti (pl) {
    let t = CMD.init + CMD.centro
    if (pl.negocio) t += negocioGrande(pl.negocio)
    if (pl.local) t += String(pl.local) + '\n'
    t += CMD.negritaOn + (pl.refTipo === 'ALQUILER' ? 'ALQUILER DE SILLA' : 'NOTA DE VENTA') + '\n' + CMD.negritaOff
    if (pl.nota) t += CMD.grande + String(pl.nota) + '\n' + CMD.normal
    t += CMD.izq + linea('=')
    t += fila('Fecha: ' + (pl.fecha || pl.hora || ''), '')
    if (pl.vendedor) t += 'Atendio: ' + pl.vendedor + '\n'
    if (pl.cliente) t += 'Cliente: ' + pl.cliente + '\n'
    t += linea()
    for (const it of lista(pl.items)) {
      t += fila(fmtCant(it.cantidad) + ' ' + it.nombre, money(Number(it.cantidad) * Number(it.precio)))
      if (it.profesional) t += '   - ' + it.profesional + '\n'
    }
    t += linea('=') + CMD.negritaOn + fila('TOTAL', montoTotal(pl.total)) + CMD.negritaOff
    for (const p of pagosDe(pl)) t += fila('  ' + p.medio, money(p.monto))
    const props = pl.montosOcultos ? [] : lista(pl.propinas)
    if (props.length) {
      t += linea() + 'PROPINAS (aparte, no suman al total)\n'
      for (const p of props) t += fila('  ' + p.profesional + ' (' + p.medio + ')', money(p.monto))
    }
    // [caja_captor_comun · KCAP-PRINT · 18-nov] Reimpresión a ciegas de una venta ajena: el servidor manda sin pagos ni propinas.
    if (pl.montosOcultos) t += 'Medios de pago: al contar la caja\n'
    t += linea('=') + CMD.centro + 'NO ES COMPROBANTE DE PAGO\n'
    t += firma(pl) + CMD.corte
    return t
  }
  function renderCierre (pl) {
    let t = CMD.init + CMD.centro
    if (pl.negocio) t += CMD.negritaOn + String(pl.negocio).toUpperCase() + '\n' + CMD.negritaOff
    t += CMD.grande + 'CORTE DE CAJA\n' + CMD.normal + CMD.izq + linea('=')
    for (const l of lista(pl.lineas)) {
      if (l && l.sep) { t += linea(String(l.sep).slice(0, 1) || '-'); continue }
      const f = fila(l.izq, l.der)
      t += l.negrita ? CMD.negritaOn + f + CMD.negritaOff : f
    }
    t += linea('=') + CMD.centro + 'Impreso ' + (pl.hora || '') + '\n'
    t += firma(pl) + CMD.corte
    return t
  }
  function renderCpe (pl) {
    const e = pl.empresa || {}; const c = pl.cliente || {}; const tot = pl.totales || {}
    const numero = pl.serie + '-' + String(pl.numero).padStart(8, '0')
    let t = CMD.init + CMD.centro + CMD.negritaOn + (e.razonSocial || e.nombre || '') + '\n' + CMD.negritaOff
    if (e.ruc) t += 'RUC ' + e.ruc + '\n'
    if (e.direccion) t += e.direccion + '\n'
    t += linea('=') + CMD.negritaOn + denomCpe(pl.tipo) + '\n' + CMD.grande + numero + '\n' + CMD.normal + CMD.negritaOff
    if (pl.estado === 'STUB') t += '*** MODO PRACTICA - SIN VALOR ***\n'
    t += CMD.izq + linea('=')
    t += fila('Fecha: ' + (pl.fecha || ''), '')
    t += 'Cliente: ' + (c.nombre || 'CLIENTE VARIOS') + '\n'
    if (c.doc && c.doc !== '0') t += (c.tipoDoc || 'DOC') + ': ' + c.doc + '\n'
    if (c.direccion) t += c.direccion + '\n'
    t += linea()
    for (const it of pl.items || []) {
      const izq = fmtCant(it.cantidad) + ' ' + it.nombre
      t += fila(KUTI ? izq : izq.slice(0, ANCHO - 10), money(it.total))
    }
    t += linea()
    const n = (x) => Number(x || 0)
    if (n(tot.gravada) > 0) t += fila('OP. GRAVADA', money(tot.gravada))
    if (n(tot.exonerada) > 0) t += fila('OP. EXONERADA', money(tot.exonerada))
    if (n(tot.inafecta) > 0) t += fila('OP. INAFECTA', money(tot.inafecta))
    if (n(tot.igv) > 0) t += fila('IGV 18%', money(tot.igv))
    // [KS-09 ICBPER · LP-R0 18-nov] Bolsas de plástico: el impuesto va aparte del IGV (RS 150-2019/SUNAT). Solo si viene;
    // misma línea que el agente .exe y el APK.
    if (n(tot.icbper) > 0) t += fila('ICBPER (bolsas)', money(tot.icbper))
    t += CMD.negritaOn + fila('TOTAL', montoTotal(pl.total)) + CMD.negritaOff
    // [LP-U1R · QA BAJO-3] sin un total válido no hay monto en letras que imprimir (vuelve a la izquierda igual)
    t += CMD.izq + (totalOk(pl.total) ? 'SON: ' + numeroALetras(pl.total) + '\n' : '')
    for (const p of (pl.montosOcultos ? [] : (pl.pagos || []))) t += fila('  ' + p.medio, money(p.monto))
    // [caja_captor_comun · KCAP-PRINT · 18-nov] Copia a ciegas de un comprobante ajeno: sin los medios de pago.
    if (pl.montosOcultos) t += 'Medios de pago: al contar la caja\n'
    t += linea('=') + CMD.centro
    if (pl.qr) t += qrEscPos(pl.qr) + '\n'
    if (pl.hash) t += 'Hash: ' + String(pl.hash).slice(0, 28) + '\n'
    t += 'Representacion impresa del\ncomprobante electronico.\nConsulte en sunat.gob.pe\n'
    t += firma(pl) + CMD.corte
    return t
  }
  // ---- TURNO (cliente sin cita; KUTI O-23) ----
  function numeroTurno (pl) {
    const v = pl.definitivo ? pl.numero : (pl.provisional || pl.numero)
    return String(v ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, Math.max(1, Math.floor(ANCHO / 3)))
  }
  function notasTurno (pl) {
    const n = []
    if (pl.definitivo) {
      const d = pl.delante == null || pl.delante === '' ? NaN : Number(pl.delante)
      if (d === 0) n.push('Es el siguiente en la cola.')
      else if (d === 1) n.push('Hay 1 persona delante.')
      else if (Number.isFinite(d) && d > 1) n.push('Hay ' + Math.floor(d) + ' personas delante.')
      n.push('Mira la pantalla de la sala: ahi sale tu numero cuando te toque.')
    } else {
      n.push('Numero provisional: se tomo sin internet.')
      n.push('Cuando vuelva la red recibes tu numero de la cola. En la pantalla de la sala lo veras junto a este, por ejemplo:')
      n.push('15 - ' + numeroTurno(pl) + ' (el 15 es un ejemplo)')
      n.push('No pierdes tu lugar: la cola va por la hora en que llegaste.')
    }
    return n
  }
  function renderTurno (pl) {
    let t = CMD.init + CMD.centro
    const neg = String(pl.negocio || ''); const loc = String(pl.local || '')
    if (neg) t += negocioGrande(neg)
    if (loc && loc !== neg) t += loc + '\n'
    t += CMD.negritaOn + 'TURNO SIN CITA' + '\n' + CMD.negritaOff + linea('=')
    t += (pl.definitivo ? 'Tu numero' : 'Tu numero provisional') + '\n'
    t += CMD.negritaOn + CMD.enorme + numeroTurno(pl) + '\n' + CMD.normal + CMD.negritaOff
    if (pl.nombre) t += String(pl.nombre).slice(0, ANCHO) + '\n'
    if (pl.con) t += ('Con ' + pl.con).slice(0, ANCHO) + '\n'
    if (pl.fecha || pl.hora) t += String(pl.fecha || pl.hora) + '\n'
    t += CMD.izq + linea()
    for (const n of notasTurno(pl)) for (const l of envolver(n, ANCHO)) t += l + '\n'
    t += linea('=')
    t += firma(pl) + CMD.corte
    return t
  }
  function renderBase (tipo, pl) {
    switch (tipo) {
      case 'COMANDA': return renderComanda(pl)
      case 'PRECUENTA': return renderPrecuenta(pl)
      case 'TICKET': return KUTI ? renderTicketKuti(pl) : renderTicketPos(pl)
      case 'CIERRE': return renderCierre(pl)
      case 'CPE': return renderCpe(pl)
      case 'CARTA_QR': return renderCartaQr(pl)
      case 'TURNO': return renderTurno(pl)
      case 'PRUEBA': return CMD.init + CMD.centro + 'PRUEBA LEVOPRINT OK\n' + (KUTI && pl.estacion ? String(pl.estacion) + '\n' : '') + firma(pl) + CMD.corte
      default: return CMD.init + JSON.stringify(pl, null, 1) + CMD.corte
    }
  }
  // Copia de un papel que SÍ salió: sello arriba (nadie la toma por un pedido nuevo ni por un segundo cobro).
  function render (tipo, payload, ancho, imagen) {
    ANCHO = Math.min(80, Math.max(24, parseInt(String(ancho || '48'), 10) || 48))
    IMAGEN = imagen !== false
    const pl = payload || {}
    const t = renderBase(String(tipo || ''), pl)
    if (!t.startsWith(CMD.init)) return t
    if (KUTI) {
      if (!(pl.copia || pl.reimpresion)) return t
      const sello = CMD.centro + CMD.negritaOn + CMD.grande + '*** COPIA ***\n' + CMD.normal + CMD.negritaOff
      return CMD.init + sello + CMD.izq + t.slice(CMD.init.length)
    }
    if (!pl.reimpresion && !pl.atrasada) return t
    let sello = CMD.centro
    if (pl.atrasada) sello += CMD.negritaOn + CMD.grande + '*** ATRASADA ***\n' + CMD.normal + 'Pedido de las ' + (pl.hora || '?') + '\n' + CMD.negritaOff
    if (pl.reimpresion) sello += CMD.negritaOn + '*** REIMPRESION ***\n' + CMD.negritaOff
    return CMD.init + sello + CMD.izq + t.slice(CMD.init.length)
  }
  // Lo que no cabe en latin1 sale «?» en vez de truncarse al byte bajo.
  const renderBase64 = (tipo, payload, ancho, imagen) =>
    Buffer.from(render(tipo, payload, ancho, imagen).replace(/[^\x00-\xff]/g, '?'), 'binary').toString('base64')
  return { render, renderBase64, pieMarca }
}
