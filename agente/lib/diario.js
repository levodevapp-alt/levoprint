// ============================================================
// LevoPrint · diario local de trabajos (F2, dedupe por jobId|estacion)
// ------------------------------------------------------------
// PORQUE: con el internet caido la comanda llega por la LAN y sale; al
// volver la red, la MISMA comanda llega desde la nube (la bandeja del mozo
// la sube). Sin diario, la cocina la recibe dos veces (PLAN F2 §4.2).
//
// Clave = "<jobId>|<estacion>" [QA F2 MEDIO-2]. Regla del contrato: UN jobId
// POR PAPEL Y ESTACION. Una venta que saca comanda en cocina y en barra puede
// usar el mismo jobId: son dos papeles distintos (dos claves) y ninguno tapa
// al otro. El jobId lo genera el CLIENTE (uuid); por la nube viaja en
// payload.jobId (o job.clave si la RPC lo devuelve). Un trabajo de la nube
// SIN jobId usa "nube:<id>" (solo protege contra un marcar fallido).
//
// Estados:
//   IMPRIMIENDO  bytes en camino a la impresora (se escribe ANTES de enviar,
//                con fsync: es el que importa si se corta la luz)
//   IMPRESO      la impresora acepto los bytes
//   ERROR        fallo SIN haber mandado nada; se puede reintentar tal cual
//   DUDOSO       no se sabe si salio: el agente se cerro con el trabajo
//                IMPRIMIENDO, o fallo a mitad del envio [QA F2 MEDIO-1]. Si
//                vuelve a llegar, se imprime CON sello REIMPRESION (cocina no
//                lo toma por pedido nuevo) en vez de callarlo.
//
// Archivo JSONL (una linea por cambio, append = barato y resistente a cortes
// de luz: una linea a medias se ignora al leer). Se compacta al arrancar y
// cuando crece; retencion 7 dias.
// `r` = ya reportado a la nube (lista impresos de <p>_agente_lan).
// ============================================================
'use strict';
const fs = require('fs');

const DIA_MS = 86400000;

function claveDe(jobId, estacion) {
  return String(jobId) + '|' + String(estacion || '-');
}

class Diario {
  constructor(archivo, opciones = {}) {
    this.archivo = archivo;
    this.retencionMs = (opciones.dias || 7) * DIA_MS;
    this.maxBytes = opciones.maxBytes || 2 * 1024 * 1024;
    this.mapa = new Map();
    this.cargar();
  }

  cargar() {
    this.mapa.clear();
    let crudo = '';
    try { crudo = fs.readFileSync(this.archivo, 'utf8'); } catch { crudo = ''; }
    for (const l of crudo.split('\n')) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }       // linea cortada por un apagon
      if (!e || typeof e.k !== 'string') continue;
      this.mapa.set(e.k, { ...(this.mapa.get(e.k) || {}), ...e });
    }
    // Lo que quedo IMPRIMIENDO al cerrarse el agente: no se sabe si salio.
    for (const e of this.mapa.values()) if (e.e === 'IMPRIMIENDO') e.e = 'DUDOSO';
    this.compactar();
  }

  compactar() {
    const limite = Date.now() - this.retencionMs;
    for (const [k, e] of this.mapa) if (!(e.ts >= limite)) this.mapa.delete(k);
    const lineas = [...this.mapa.values()].map((e) => JSON.stringify(e)).join('\n');
    try {
      const tmp = this.archivo + '.tmp';
      fs.writeFileSync(tmp, lineas ? lineas + '\n' : '');
      fs.renameSync(tmp, this.archivo);
    } catch { /* carpeta de solo lectura: el diario queda en memoria */ }
  }

  get(k) { return this.mapa.get(String(k)) || null; }

  estado(k) { const e = this.get(k); return e ? e.e : null; }

  // Cambia el estado y lo deja en disco al toque (antes de mandar bytes).
  // [QA F2 BAJO] IMPRIMIENDO va con fsync: si se corta la luz justo despues,
  // al volver se sabe que ese papel quedo DUDOSO.
  poner(k, datos) {
    const prev = this.mapa.get(k) || { k };
    const e = { ...prev, ...datos, k, ts: Date.now() };
    this.mapa.set(k, e);
    try {
      const fd = fs.openSync(this.archivo, 'a');
      try {
        fs.writeSync(fd, JSON.stringify(e) + '\n');
        if (e.e === 'IMPRIMIENDO' && datos.e === 'IMPRIMIENDO') fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (fs.statSync(this.archivo).size > this.maxBytes) this.compactar();
    } catch { /* disco lleno: sigue en memoria */ }
    return e;
  }

  // Impresos por la LAN que la nube aun no sabe (para <p>_agente_lan).
  sinReportar(max = 200) {
    const out = [];
    for (const e of this.mapa.values()) {
      if (e.e === 'IMPRESO' && e.o === 'LAN' && !e.r && e.j && e.est && !String(e.j).startsWith('nube:')) {
        out.push({ k: e.k, clave: e.j, estacion: e.est, ts: new Date(e.ts).toISOString() });
      }
      if (out.length >= max) break;
    }
    return out;
  }

  marcarReportados(claves) {
    for (const k of claves || []) {
      const e = this.mapa.get(k);
      if (e && !e.r) this.poner(k, { r: true });
    }
  }

  recientes(n = 50) {
    return [...this.mapa.values()].sort((a, b) => b.ts - a.ts).slice(0, n)
      .map((e) => ({ jobId: e.j || e.k, estado: e.e, origen: e.o || null, estacion: e.est || null, tipo: e.t || null, ts: e.ts }));
  }
}

// jobId de un trabajo de la nube (o "nube:<id>" si no trae).
function jobIdDeNube(job) {
  const pl = (job && job.payload) || {};
  const c = (job && job.clave) || pl.jobId;
  if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
  return 'nube:' + String(job && job.id);
}

// Clave de dedupe de un trabajo de la nube: jobId|estacion.
function claveDeNube(job) {
  return claveDe(jobIdDeNube(job), job && job.estacion);
}

// jobId valido del cliente: uuid o texto corto sin espacios (8 a 80).
function jobIdValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9:_\-.]{8,80}$/.test(id) && !id.startsWith('nube:');
}

module.exports = { Diario, claveDe, claveDeNube, jobIdDeNube, jobIdValido };
