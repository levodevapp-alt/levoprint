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
const { claveDe } = require('./diario');

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
      // [F2] v (version de la ruta) solo llega por agente_lan: agente_config no la trae y no se debe perder.
      nuevo.set(e.id, { ...e, transporte: e.transporte !== undefined ? e.transporte : prev.transporte, destino: e.destino !== undefined ? e.destino : prev.destino, v: e.v !== undefined ? e.v : prev.v });
    }
    this.estaciones = nuevo;
    this.estacionesTs = Date.now();
    this.estacionesPrefijo = prefijo || null;
    this.guardarJson(this.archivoEstaciones, { prefijo, ts: this.estacionesTs, estaciones: [...nuevo.values()] });
  }

  // transporte/destino desde <p>_agente_lan (columnas nuevas de estaciones).
  // [QA F2 ALTO-1] Una asignacion LOCAL ya confirmada por la nube no puede
  // mandar para siempre: si la nube trae otra cosa (el dueno la cambio desde
  // la app), la local se descarta y manda la nube. Solo sobrevive la que
  // todavia esta pendienteNube (se hizo sin internet y aun no se aviso).
  ponerTransportes(lista) {
    let cambio = false;
    let cambioAsig = false;
    for (const t of lista || []) {
      const e = this.estaciones.get(t.id);
      if (!e) continue;
      const tr = t.transporte || null; const de = t.destino || null;
      if (e.transporte !== tr || e.destino !== de) { e.transporte = tr; e.destino = de; cambio = true; }
      // [re-QA F2 A->B->A] version de la ruta en la nube (estaciones.transporte_v)
      const v = Number.isInteger(t.v) ? t.v : null;
      if (v !== null && e.v !== v) { e.v = v; cambio = true; }
      const a = this.asignaciones[t.id];
      // [re-QA F2] Una PENDIENTE tambien se descarta si la nube cambio desde que
      // se asigno (nubeAntes = lo que tenia la nube en ese momento): el cambio
      // del dueno en la app es mas nuevo y el reintento no lo debe pisar.
      const antes = (a && a.nubeAntes) || {};
      // Con version conocida se compara la VERSION (A->B->A deja el mismo valor
      // pero dos cambios del dueno); sin ella, el valor.
      const v2 = Number.isInteger(t.v) ? t.v : null;
      const porVersion = v2 !== null && Number.isInteger(antes.v);
      const nubeCambio = !!(a && a.pendienteNube && (porVersion ? antes.v !== v2
        : ((antes.transporte || null) !== tr || (antes.destino || null) !== de)));
      const sincronizadaDistinta = !!(a && !a.pendienteNube && (a.transporte !== tr || a.destino !== de));
      if (nubeCambio || sincronizadaDistinta) {
        delete this.asignaciones[t.id];
        cambioAsig = true;
        this.log(`[asignar] ${e.nombre}: la nube trae otra impresora (${tr ? transportes.describir({ transporte: tr, destino: de }) : 'la de siempre'}); se descarta la asignacion de esta PC.`);
      }
    }
    if (cambio) this.guardarJson(this.archivoEstaciones, { prefijo: this.estacionesPrefijo, ts: this.estacionesTs, estaciones: [...this.estaciones.values()] });
    if (cambioAsig) this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  // Asignacion hecha en esta PC (asistente Buscar impresoras). Nace
  // pendienteNube: manda hasta que la nube la confirme (confirmarNube) y,
  // mientras tanto, el latido reintenta avisarla.
  asignar(estacionId, transporte, destino, opciones = {}) {
    const problema = transportes.validarDestino(transporte, destino);
    if (problema) throw new Error(problema);
    // nubeAntes: lo que la nube tenia al asignar (para no pisar un cambio posterior del dueno).
    const est = this.estaciones.get(estacionId) || {};
    this.asignaciones[estacionId] = {
      transporte, destino: String(destino), ts: Date.now(), pendienteNube: opciones.pendienteNube !== false,
      nubeAntes: { transporte: est.transporte || null, destino: est.destino || null, v: Number.isInteger(est.v) ? est.v : null },
    };
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  // La nube ya la tiene: se copia a la estacion y se BORRA la local (desde
  // ahora manda la nube; si el dueno la cambia en la app, se respeta).
  // v = version que devolvio la nube (agente_asignar): la proxima asignacion
  // local parte de ella y no choca consigo misma.
  confirmarNube(estacionId, v) {
    const a = this.asignaciones[estacionId];
    if (!a) return;
    const e = this.estaciones.get(estacionId);
    if (e) {
      e.transporte = a.transporte; e.destino = a.destino;
      if (Number.isInteger(v)) e.v = v;
      this.guardarJson(this.archivoEstaciones, { prefijo: this.estacionesPrefijo, ts: this.estacionesTs, estaciones: [...this.estaciones.values()] });
    }
    delete this.asignaciones[estacionId];
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  // La base no tiene <p>_agente_asignar (plantilla sin aplicar): la local
  // queda como unica fuente, ya sin reintentos.
  quedarSoloLocal(estacionId) {
    const a = this.asignaciones[estacionId];
    if (!a || !a.pendienteNube) return;
    a.pendienteNube = false;
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
  }

  // La nube rechazo el aviso porque cambio despues (CAMBIO_EN_NUBE): manda la
  // nube y la local se descarta.
  descartarPorNube(estacionId) {
    if (!this.asignaciones[estacionId]) return;
    delete this.asignaciones[estacionId];
    this.guardarJson(this.archivoAsignaciones, this.asignaciones);
    this.log(`[asignar] la nube cambio la impresora de ${(this.estaciones.get(estacionId) || {}).nombre || estacionId} despues de asignarla aqui: se descarta la asignacion de esta PC.`);
  }

  pendientesNube() {
    return Object.entries(this.asignaciones).filter(([, a]) => a && a.pendienteNube).map(([id, a]) => ({ estacion: id, ...a }));
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
      return {
        id: e.id, nombre: e.nombre, ip: e.ip || null, puerto: e.puerto || 9100, ruta: r, via: transportes.describir(r),
        fuente: r ? r.fuente : null, pendienteNube: !!(r && r.pendienteNube),
        cola: r ? this.colas.enEspera(r.transporte + '|' + r.destino) : 0,
      };
    });
  }

  // Imprime UN papel con dedupe. j: { jobId, origen: 'NUBE'|'LAN', estacion,
  // tipo, payload, renderTexto?: async (job) => string }.
  // Clave del diario = jobId|estacion (un jobId por papel y estacion).
  // Devuelve { ok, duplicado?, via, error?, errorInterno?, dudoso? }. Nunca lanza.
  procesar(j) {
    const clave = claveDe(j.jobId, j.estacion);
    if (this.enCurso.has(clave)) return this.enCurso.get(clave).then((r) => ({ ...r, duplicado: true }));
    const p = this._procesar({ ...j, clave }).finally(() => this.enCurso.delete(clave));
    this.enCurso.set(clave, p);
    return p;
  }

  async _procesar(j) {
    const previo = this.diario.get(j.clave);
    let payload = j.payload || {};
    // [re-QA F2 NUEVO-1] La dedupe es SIEMPRE por jobId|estacion, tambien con
    // payload.reimpresion: una reimpresion lleva un jobId NUEVO (lo genera
    // core/front/lib/impresora.js). Si la reimpresion saltara la dedupe, el
    // papel que salio por la LAN volveria a salir cuando la nube lo entregue
    // con el mismo jobId (respaldo LAN -> nube).
    if (previo && previo.e === 'IMPRESO') return { ok: true, duplicado: true, via: previo.via || null };
    const est = this.estaciones.get(j.estacion);
    const ruta = this.ruta(j.estacion);
    // DUDOSO: no se sabe si salio; si vuelve, sale con sello (no como pedido nuevo).
    if (previo && previo.e === 'DUDOSO' && !payload.reimpresion) payload = { ...payload, reimpresion: true };
    const job = { tipo: j.tipo, payload };
    const base = { o: j.origen, j: j.jobId, est: j.estacion, t: j.tipo };

    if (this.modoConsola || !ruta) {
      const texto = this.renderPara(this.getAncho()).render(job);
      this.log(`\n--- JOB ${j.clave} (${j.tipo}) -> ${est ? est.nombre : 'SIN ESTACION'} ---`);
      this.log(texto.replace(/[\x00-\x1f]/g, '').trim());
      if (!this.modoConsola) {
        const error = !est ? 'estacion desconocida' : 'estacion sin impresora asignada';
        if (j.origen === 'LAN') this.diario.poner(j.clave, { ...base, e: 'ERROR', err: error });
        return { ok: false, error, via: null };
      }
      this.diario.poner(j.clave, { ...base, e: 'IMPRESO', via: 'consola' });
      return { ok: true, via: 'consola' };
    }

    const colaKey = ruta.transporte + '|' + ruta.destino;
    const via = transportes.describir(ruta);
    let enviando = false;
    try {
      await this.colas.encolar(colaKey, async (cola) => {
        // Render dentro de la cola (formato al dia) y ANTES de marcar IMPRIMIENDO.
        let texto;
        if (j.renderTexto) {
          try { texto = await j.renderTexto(job); } catch (_) { texto = null; }
        }
        if (!texto) texto = this.renderPara(this.getAncho()).render(job);
        // El tope de la cola vencio mientras se armaba el papel: no se manda nada.
        if (cola && cola.abandonada) { const e = new Error('abandonada por tiempo antes de enviar'); e.sinEnviar = true; throw e; }
        this.diario.poner(j.clave, { ...base, e: 'IMPRIMIENDO' });
        enviando = true;
        await this.enviar(ruta, texto, { timeoutMs: ruta.transporte === 'USB_WIN' ? 25000 : 10000 });
      }, ruta.transporte === 'USB_WIN' ? 35000 : 20000);
      this.diario.poner(j.clave, { e: 'IMPRESO', via });
      this.log(`[ok] ${j.origen === 'LAN' ? 'LAN' : 'nube'} ${j.clave} ${j.tipo} -> ${est ? est.nombre : j.estacion} (${via})`);
      return { ok: true, via };
    } catch (e) {
      // [QA F2 MEDIO-1] Si ya se empezo a mandar y no es seguro que nada
      // salio (conexion rechazada, impresora que no abrio), queda DUDOSO: el
      // reintento sale con sello REIMPRESION.
      const dudoso = enviando && !e.sinEnviar;
      this.diario.poner(j.clave, { ...base, e: dudoso ? 'DUDOSO' : 'ERROR', err: String(e.message).slice(0, 200) });
      this.logErr(`[err] ${j.origen === 'LAN' ? 'LAN' : 'nube'} ${j.clave}${dudoso ? ' (DUDOSO)' : ''}: ${e.message}`);
      return { ok: false, error: transportes.mensajePublico(e), errorInterno: e.message, via, dudoso };
    }
  }
}

module.exports = { Motor };
