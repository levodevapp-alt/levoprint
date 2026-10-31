// ============================================================
// LevoPrint · diario local de trabajos (F2, dedupe por jobId)
// ------------------------------------------------------------
// PORQUE: con el internet caido la comanda llega por la LAN y sale; al
// volver la red, la MISMA comanda llega desde la nube (la bandeja del mozo
// la sube). Sin diario, la cocina la recibe dos veces (PLAN F2 §4.2).
//
// Clave = jobId que genera el CLIENTE (uuid). Por la nube viaja en
// payload.jobId (o job.clave si la RPC lo devuelve). Un trabajo de la nube
// SIN jobId usa "nube:<id>" (solo protege contra un marcar fallido).
//
// Estados:
//   IMPRIMIENDO  bytes en camino a la impresora (se escribe ANTES de enviar)
//   IMPRESO      la impresora acepto los bytes
//   ERROR        fallo; se puede reintentar con el mismo jobId
//   DUDOSO       el agente se cerro con el trabajo IMPRIMIENDO: no se sabe si
//                salio. Si vuelve a llegar, se imprime CON sello REIMPRESION
//                (cocina no lo toma por pedido nuevo) en vez de callarlo.
//
// Archivo JSONL (una linea por cambio, append = barato y resistente a cortes
// de luz: una linea a medias se ignora al leer). Se compacta al arrancar y
// cuando crece; retencion 7 dias.
// `r` = ya reportado a la nube (lista impresos de <p>_agente_lan).
// ============================================================
'use strict';
const fs = require('fs');

const DIA_MS = 86400000;

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
  poner(k, datos) {
    const prev = this.mapa.get(k) || { k };
    const e = { ...prev, ...datos, k, ts: Date.now() };
    this.mapa.set(k, e);
    try {
      fs.appendFileSync(this.archivo, JSON.stringify(e) + '\n');
      if (fs.statSync(this.archivo).size > this.maxBytes) this.compactar();
    } catch { /* disco lleno: sigue en memoria */ }
    return e;
  }

  // Impresos por la LAN que la nube aun no sabe (para <p>_agente_lan).
  sinReportar(max = 200) {
    const out = [];
    for (const e of this.mapa.values()) {
      if (e.e === 'IMPRESO' && e.o === 'LAN' && !e.r && !String(e.k).startsWith('nube:')) out.push({ clave: e.k, estacion: e.est || null, ts: new Date(e.ts).toISOString() });
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
      .map((e) => ({ jobId: e.k, estado: e.e, origen: e.o || null, estacion: e.est || null, tipo: e.t || null, ts: e.ts }));
  }
}

// Clave de dedupe de un trabajo de la nube.
function claveDeNube(job) {
  const pl = (job && job.payload) || {};
  const c = (job && job.clave) || pl.jobId;
  if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
  return 'nube:' + String(job && job.id);
}

// jobId valido del cliente: uuid o texto corto sin espacios (8 a 80).
function jobIdValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9:_\-.]{8,80}$/.test(id) && !id.startsWith('nube:');
}

module.exports = { Diario, claveDeNube, jobIdValido };
