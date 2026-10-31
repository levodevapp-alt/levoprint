// ============================================================
// LevoPrint · motor de impresion comun a la NUBE y a la LAN (F2)
// ------------------------------------------------------------
// Un solo camino para todo papel, venga de <p>_print_tomar o de POST
// /v1/imprimir:
//   clave (jobId) -> diario (ya impreso? en curso?) -> ruta de la estacion
//   -> cola de ESA impresora -> render -> IMPRIMIENDO -> bytes -> IMPRESO.
// Asi la dedupe es la misma venga por donde venga: si la comanda salio por la
// LAN y luego llega desde la nube con el mismo jobId, se marca impresa sin
// sacar otro papel.
//
// Estaciones: la lista de la nube (agente_config + transporte/destino de
// <p>_agente_lan) se guarda en disco para poder imprimir por la LAN aunque el
// agente arranque SIN internet. La asignacion hecha en la ventana local
// (Buscar impresoras) manda sobre la de la nube y tambien se guarda.
// ============================================================
'use strict';
const fs = require('fs');
const transportes = require('./transportes');

class Motor {
  constructor(op) {
    this.diario = op.diario;
    this.colas = op.colas;
    this.renderPara = op.renderPara;
    this.getAncho = op.getAncho || (() => 48);
    this.modoConsola = !!op.modoConsola;
    this.log = op.log || console.log;
    this.logErr = op.logErr || console.error;
    this.enviar = op.enviar || transportes.enviar;
    this.archivoEstaciones = op.archivoEstaciones;
    this.archivoAsignaciones = op.archivoAsignaciones;
    this.estaciones = new Map();
    this.asignaciones = {};
    this.enCurso = new Map();          // clave -> promesa (dos pedidos iguales a la vez = un papel)
    this.cargarDisco();
  }

  cargarDisco() {
    try {
      const j = JSON.parse(fs.readFileSync(this.archivoEstaciones, 'utf8'));
      if (Array.isArray(j.estaciones)) this.estaciones = new Map(j.estaciones.map((e) => [e.id, e]));
      this.estacionesTs = j.ts || null;
      this.estacionesPrefijo = j.prefijo || null;
    } catch { /* primera vez */ }
    try {
      const j = JSON.parse(fs.readFileSync(this.archivoAsignaciones, 'utf8'));
      if (j && typeof j === 'object') this.asignaciones = j;
    } catch { /* primera vez */ }
  }

  guardarJson(archivo, obj) {
    if (!archivo) return;
    try { fs.writeFileSync(archivo + '.tmp', JSON.stringify(obj, null, 1)); fs.renameSync(archivo + '.tmp', archivo); } catch { /* solo lectura */ }
  }

  // Lista de la nube (agente_config). Conserva transporte/destino ya conocidos
  // si esta respuesta no los trae (agente_config viejo no los manda).
  ponerEstaciones(lista, prefijo) {
    const nuevo = new Map();
    for (const e of lista || []) {
      const prev = this.estaciones.get(e.id) || {};
      nuevo.set(e.id, { ...e, transporte: e.transporte !== undefined ? e.transporte : prev.transporte, destino: e.destino !== undefined ? e.destino : prev.destino });
    }
    this.estaciones = nuevo;
    this.estacionesTs = Date.now();
    this.estacionesPrefijo = prefijo || null;
    this.guardarJson(this.archivoEstaciones, { prefijo, ts: this.estacionesTs, estaciones: [...nuevo.values()] });
  }

  // transporte/destino desde <p>_agente_lan (columnas nuevas de estaciones).
  ponerTransportes(lista) {
    let cambio = false;
    for (const t of lista || []) {
      const e = this.estaciones.get(t.id);
      if (!e) continue;
      if (e.transporte !== (t.transporte || null) || e.destino !== (t.destino || null)) {
        e.transporte = t.transporte || null; e.destino = t.destino || null; cambio = true;
      }
    }
    if (cambio) this.guardarJson(this.archivoEstaciones, { prefijo: this.estacionesPrefijo, ts: this.estacionesTs, estaciones: [...this.estaciones.values()] });
  }

  asignar(estacionId, transporte, destino) {
    if (!transportes.TRANSPORTES.includes(transporte)) throw new Error('transporte invalido');
    if (!destino || String(destino).length > 120) throw new Error('destino invalido');
    this.asignaciones[estacionId] = { transporte, destino: String(destino), ts: Date.now() };
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  desasignar(estacionId) {
    delete this.asignaciones[estacionId];
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  ruta(estacionId) {
    return transportes.rutaDeEstacion(this.estaciones.get(estacionId), this.asignaciones[estacionId]);
  }

  listaEstaciones() {
    return [...this.estaciones.values()].map((e) => {
      const r = this.ruta(e.id);
      return { id: e.id, nombre: e.nombre, ip: e.ip || null, puerto: e.puerto || 9100, ruta: r, via: transportes.describir(r), cola: r ? this.colas.enEspera(r.transporte + '|' + r.destino) : 0 };
    });
  }

  // Imprime UN trabajo con dedupe. j: { clave, origen: 'NUBE'|'LAN', estacion,
  // tipo, payload, renderTexto?: async (job) => string }.
  // Devuelve { ok, duplicado?, via, error? }. Nunca lanza.
  procesar(j) {
    const clave = j.clave;
    if (this.enCurso.has(clave)) return this.enCurso.get(clave).then((r) => ({ ...r, duplicado: true }));
    const p = this._procesar(j).finally(() => this.enCurso.delete(clave));
    this.enCurso.set(clave, p);
    return p;
  }

  async _procesar(j) {
    const previo = this.diario.get(j.clave);
    if (previo && previo.e === 'IMPRESO') return { ok: true, duplicado: true, via: previo.via || null };
    const est = this.estaciones.get(j.estacion);
    const ruta = this.ruta(j.estacion);
    let payload = j.payload || {};
    // DUDOSO: el agente se cerro a mitad; si vuelve, sale con sello (no como pedido nuevo).
    if (previo && previo.e === 'DUDOSO' && !payload.reimpresion) payload = { ...payload, reimpresion: true };
    const job = { tipo: j.tipo, payload };

    if (this.modoConsola || !ruta) {
      const texto = this.renderPara(this.getAncho()).render(job);
      this.log(`\n--- JOB ${j.clave} (${j.tipo}) -> ${est ? est.nombre : 'SIN ESTACION'} ---`);
      this.log(texto.replace(/[\x00-\x1f]/g, '').trim());
      if (!this.modoConsola) {
        const error = !est ? 'estacion desconocida' : 'estacion sin impresora asignada';
        if (j.origen === 'LAN') this.diario.poner(j.clave, { e: 'ERROR', o: j.origen, est: j.estacion, t: j.tipo, err: error });
        return { ok: false, error, via: null };
      }
      this.diario.poner(j.clave, { e: 'IMPRESO', o: j.origen, est: j.estacion, t: j.tipo, via: 'consola' });
      return { ok: true, via: 'consola' };
    }

    const colaKey = ruta.transporte + '|' + ruta.destino;
    const via = transportes.describir(ruta);
    try {
      await this.colas.encolar(colaKey, async () => {
        // Render dentro de la cola (formato al dia) y ANTES de marcar IMPRIMIENDO.
        let texto;
        if (j.renderTexto) {
          try { texto = await j.renderTexto(job); } catch (_) { texto = null; }
        }
        if (!texto) texto = this.renderPara(this.getAncho()).render(job);
        this.diario.poner(j.clave, { e: 'IMPRIMIENDO', o: j.origen, est: j.estacion, t: j.tipo });
        await this.enviar(ruta, texto, { timeoutMs: ruta.transporte === 'USB_WIN' ? 25000 : 10000 });
      }, ruta.transporte === 'USB_WIN' ? 35000 : 20000);
      this.diario.poner(j.clave, { e: 'IMPRESO', via });
      this.log(`[ok] ${j.origen === 'LAN' ? 'LAN' : 'nube'} ${j.clave} ${j.tipo} -> ${est ? est.nombre : j.estacion} (${via})`);
      return { ok: true, via };
    } catch (e) {
      this.diario.poner(j.clave, { e: 'ERROR', o: j.origen, est: j.estacion, t: j.tipo, err: String(e.message).slice(0, 200) });
      this.logErr(`[err] ${j.origen === 'LAN' ? 'LAN' : 'nube'} ${j.clave}: ${e.message}`);
      return { ok: false, error: e.message, via };
    }
  }
}

module.exports = { Motor };
