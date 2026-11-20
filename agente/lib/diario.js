// ============================================================
// LevoPrint · diario anti-duplicado de papeles (LP-O02, portado de F2)
// ------------------------------------------------------------
// PORQUE: sin internet en el local, la comanda llega por la LAN (:9120) y
// sale; al volver la red, la MISMA comanda llega desde la nube (la bandeja
// del mozo la sube con payload.jobId). Sin diario, la cocina la recibe dos
// veces. Tambien protege la ruta de la nube: si print_marcar falla tras
// imprimir (se cayo la red justo despues), el servidor vuelve a entregar el
// trabajo y el diario lo da por hecho sin repetir el papel.
//
// Clave = "<jobId>|<estacion>". Regla del contrato: UN jobId POR PAPEL Y
// ESTACION (offline_komo: jobId = clienteKey:estacion_id). Un trabajo de la
// nube sin payload.jobId, o que no es COMANDA/PRECUENTA, usa
// "nube:<prefijo>:<id>" (solo cubre el marcar fallido; nunca se reporta a
// <prefijo>_agente_lan).
//
// Estados:
//   ENVIANDO  bytes en camino (se escribe ANTES de enviar, con fsync: si se
//             corta la luz justo despues, al volver se sabe que quedo a medias)
//   IMPRESO   la impresora acepto los bytes
//   FALLO     fallo SIN haber mandado nada (conexion rechazada, cola que no
//             abre): el reintento sale normal
//   DUDOSO    no se sabe si salio: fallo a mitad del envio, o el agente se
//             cerro con el papel ENVIANDO. El reintento sale CON sello
//             REIMPRESION (cocina no lo toma por pedido nuevo).
//
// Archivo JSONL (una linea por cambio, fsync en cada una). Una linea cortada
// por un apagon o basura en el archivo se ignora al leer (no tumba el
// agente). Se compacta al arrancar, cada dia y si pasa de 1 MB: escritura
// atomica (tmp + fsync + rename). Retencion 7 dias.
// Campos: k clave, j jobId, est estacion, p prefijo, o origen (LAN|NUBE),
// e estado, t tipo, ts, r = respuesta de la nube (<prefijo>_agente_lan):
//   false/ausente  aun no avisado
//   true           la nube lo registro
//   'rechazado'    la nube lo rechazo (jobId ajeno, estacion de otro local,
//                  papel que no existe...): NO se reenvia nunca
// n = veces que se mando en un latido con respuesta de la nube. Tope
// MAX_ENVIOS_LAN: una fila que la nube nunca registra ni rechaza deja de
// mandarse (no ocupa el lote para siempre).
// La marca es POR FILA = (jobId, estacion): un mismo jobId puede quedar
// registrado en una estacion y rechazado en otra.
// ============================================================
'use strict';
const fs = require('fs');

const DIA_MS = 86400000;
const ESTADOS = ['ENVIANDO', 'IMPRESO', 'FALLO', 'DUDOSO'];
const MAX_ENVIOS_LAN = 20;

function claveDe(jobId, estacion) {
  return String(jobId) + '|' + String(estacion || '-');
}

// jobId valido del cliente: uuid o texto corto sin espacios (8 a 80).
function jobIdValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9:_\-.]{8,80}$/.test(id) && !id.startsWith('nube:');
}

// [QA MEDIO-2] Solo estos papeles de la nube se cruzan con la LAN por payload.jobId.
// Un TICKET / CPE / CIERRE / TURNO de la nube SIEMPRE se imprime aunque traiga un
// jobId que ya salio por la LAN: la LAN no imprime papeles de dinero, y un equipo
// emparejado no debe poder "tapar" un comprobante adelantando su jobId.
const TIPOS_DEDUPE_LAN = ['COMANDA', 'PRECUENTA'];

// Clave de un trabajo de la nube: payload.jobId|estacion (solo COMANDA/PRECUENTA) o
// nube:<prefijo>:<id>|estacion (el id del trabajo en la nube: cubre solo el
// print_marcar perdido, que reentrega el MISMO trabajo; no lo controla la LAN).
function claveDeNube(prefijo, job) {
  const pl = (job && job.payload) || {};
  const cruza = TIPOS_DEDUPE_LAN.includes(job && job.tipo) && jobIdValido(pl.jobId);
  const j = cruza ? pl.jobId : 'nube:' + String(prefijo || '') + ':' + String(job && job.id);
  return { clave: claveDe(j, job && job.estacion), jobId: j };
}

function escribirAtomico(archivo, texto) {
  const tmp = archivo + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, texto); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, archivo);
}

class Diario {
  constructor(archivo, opciones) {
    const o = opciones || {};
    this.archivo = archivo;
    this.retencionMs = (o.dias || 7) * DIA_MS;
    this.maxBytes = o.maxBytes || 1024 * 1024;
    this.ahora = o.ahora || (() => Date.now());
    this.mapa = new Map();
    this.candados = new Map();
    this.lineasMalas = 0;
    this.compactadoTs = 0;
    this.enDisco = true;
    this.cargar();
  }

  cargar() {
    this.mapa.clear();
    this.lineasMalas = 0;
    let crudo = '';
    try { crudo = fs.readFileSync(this.archivo, 'utf8'); } catch { crudo = ''; }
    for (const l of crudo.split('\n')) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { this.lineasMalas++; continue; }
      if (!e || typeof e.k !== 'string' || !ESTADOS.includes(e.e) || typeof e.ts !== 'number') { this.lineasMalas++; continue; }
      this.mapa.set(e.k, Object.assign({}, this.mapa.get(e.k) || {}, e));
    }
    // Lo que quedo ENVIANDO al cerrarse el agente: no se sabe si salio.
    for (const e of this.mapa.values()) if (e.e === 'ENVIANDO') e.e = 'DUDOSO';
    this.compactar();
  }

  compactar() {
    const limite = this.ahora() - this.retencionMs;
    for (const [k, e] of this.mapa) if (!(e.ts >= limite)) this.mapa.delete(k);
    const lineas = [...this.mapa.values()].map((e) => JSON.stringify(e)).join('\n');
    try { escribirAtomico(this.archivo, lineas ? lineas + '\n' : ''); this.enDisco = true; }
    catch { this.enDisco = false; /* carpeta de solo lectura: el diario queda en memoria */ }
    this.compactadoTs = this.ahora();
  }

  get(k) { return this.mapa.get(String(k)) || null; }
  estado(k) { const e = this.get(k); return e ? e.e : null; }

  // Cambia el estado y lo deja en disco al toque (fsync en cada cambio).
  poner(k, datos) {
    const prev = this.mapa.get(k) || { k };
    const e = Object.assign({}, prev, datos, { k, ts: this.ahora() });
    this.mapa.set(k, e);
    try {
      const fd = fs.openSync(this.archivo, 'a');
      try { fs.writeSync(fd, JSON.stringify(e) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.enDisco = true;
      if (fs.statSync(this.archivo).size > this.maxBytes || this.ahora() - this.compactadoTs > DIA_MS) this.compactar();
    } catch { this.enDisco = false; /* disco lleno: sigue en memoria */ }
    return e;
  }

  // Un papel, con candado por clave: dos pedidos con la misma clave (la app
  // reintenta mientras el primero imprime, o LAN y nube a la vez) no salen
  // los dos: el segundo espera y ve IMPRESO.
  //   op = { clave, jobId, estacion, prefijo, origen, tipo,
  //          render(reimpresion) -> texto, enviar(texto) }
  // Devuelve { estado: 'IMPRESO'|'YA_IMPRESO', reimpresion } o lanza el error
  // de enviar con e.estadoDiario = 'DUDOSO'|'FALLO'. e.dudoso = true en el
  // error de enviar significa "pudo haber salido".
  procesar(op) {
    const k = op.clave;
    const previo = this.candados.get(k) || Promise.resolve();
    const p = previo.then(() => this._procesar(op));
    const fin = p.catch(() => {}).then(() => { if (this.candados.get(k) === fin) this.candados.delete(k); });
    this.candados.set(k, fin);
    return p;
  }

  async _procesar(op) {
    const k = op.clave;
    const antes = this.get(k);
    if (antes && antes.e === 'IMPRESO') return { estado: 'YA_IMPRESO', reimpresion: false };
    const reimpresion = !!(antes && (antes.e === 'DUDOSO' || antes.e === 'ENVIANDO'));
    const texto = await op.render(reimpresion);   // si el render falla no se toca el diario
    const base = { j: op.jobId, est: op.estacion || null, p: op.prefijo || null, o: op.origen || null, t: op.tipo || null, r: false };
    this.poner(k, Object.assign({}, base, { e: 'ENVIANDO' }));
    try {
      await op.enviar(texto);
    } catch (err) {
      const estado = err && err.dudoso ? 'DUDOSO' : 'FALLO';
      // Si ya estaba DUDOSO y ahora falla sin mandar nada, sigue DUDOSO (el primero pudo salir).
      this.poner(k, { e: estado === 'FALLO' && reimpresion ? 'DUDOSO' : estado });
      if (err && typeof err === 'object') err.estadoDiario = this.estado(k);
      throw err;
    }
    this.poner(k, { e: 'IMPRESO' });
    return { estado: 'IMPRESO', reimpresion };
  }

  // Impresos por la LAN de una app que la nube aun no sabe (para <prefijo>_agente_lan).
  // Lo MAS RECIENTE primero: basura vieja que la nube no acepta no tapa lo nuevo.
  // Fuera: lo registrado (r true), lo rechazado (r 'rechazado') y lo que ya se
  // mando MAX_ENVIOS_LAN veces sin respuesta util.
  sinReportar(prefijo, max) {
    const cand = [];
    for (const e of this.mapa.values()) {
      if (e.e === 'IMPRESO' && e.o === 'LAN' && !e.r && e.p === prefijo && e.j && !String(e.j).startsWith('nube:')
        && !((e.n || 0) >= MAX_ENVIOS_LAN)) cand.push(e);
    }
    cand.sort((a, b) => b.ts - a.ts);
    return cand.slice(0, max || 100).map((e) => ({ k: e.k, clave: e.j, estacion: e.est, ts: new Date(e.ts).toISOString() }));
  }

  // Respuesta de <prefijo>_agente_lan a un lote. Acepta las dos formas:
  //   detallada (por estacion): registrados_det / rechazados_det = [{clave, estacion, motivo?}] o [[clave, estacion]]
  //   compatible (solo claves): registrados / rechazados = [jobId] -> aplica a TODAS las filas
  //                              de ESTE lote con esa clave.
  // Si viene el detalle de una lista, se usa el detalle y se ignora la lista de claves de ese tipo.
  // Toda fila del lote suma un envio (n); al llegar a MAX_ENVIOS_LAN sin marca deja de mandarse.
  // Devuelve { registrados, rechazados, agotados } (cuantas filas cambiaron).
  marcarRespuesta(enviados, resp) {
    const r = resp || {};
    const pares = (lista) => {
      if (!Array.isArray(lista)) return null;
      const s = new Set();
      for (const x of lista) {
        if (Array.isArray(x) && x.length >= 2) s.add(claveDe(x[0], x[1]));
        else if (x && typeof x === 'object' && x.clave != null) s.add(claveDe(x.clave, x.estacion));
      }
      return s;
    };
    const claves = (lista) => new Set((Array.isArray(lista) ? lista : []).filter((x) => typeof x === 'string' || typeof x === 'number').map(String));
    const regDet = pares(r.registrados_det), rechDet = pares(r.rechazados_det);
    const regCl = claves(r.registrados), rechCl = claves(r.rechazados);
    const cuenta = { registrados: 0, rechazados: 0, agotados: 0 };
    let cambio = false;
    for (const x of enviados || []) {
      const e = this.mapa.get(x.k);
      if (!e || e.r) continue;
      const par = claveDe(x.clave, x.estacion);
      const reg = regDet ? regDet.has(par) : regCl.has(String(x.clave));
      const rech = rechDet ? rechDet.has(par) : rechCl.has(String(x.clave));
      const n = (e.n || 0) + 1;
      let marca = false;
      if (reg) { marca = true; cuenta.registrados++; }              // registrado gana si la nube lo pone en las dos
      else if (rech) { marca = 'rechazado'; cuenta.rechazados++; }
      else if (n >= MAX_ENVIOS_LAN) cuenta.agotados++;
      this.mapa.set(x.k, Object.assign({}, e, { r: marca, n }));
      cambio = true;
    }
    if (cambio) this.compactar();   // r y n no cambian la dedupe: basta con reescribir una vez
    return cuenta;
  }

  // Forma vieja (solo registrados:[jobId]). Devuelve cuantas filas quedaron registradas.
  marcarReportados(enviados, registrados) {
    return this.marcarRespuesta(enviados, { registrados }).registrados;
  }

  recientes(n) {
    return [...this.mapa.values()].sort((a, b) => b.ts - a.ts).slice(0, n || 50)
      .map((e) => ({ jobId: e.j || e.k, estacion: e.est || null, estado: e.e, origen: e.o || null, tipo: e.t || null, ts: e.ts }));
  }
}

module.exports = { Diario, claveDe, claveDeNube, jobIdValido, MAX_ENVIOS_LAN, TIPOS_DEDUPE_LAN };
