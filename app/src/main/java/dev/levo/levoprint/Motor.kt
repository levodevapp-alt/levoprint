package dev.levo.levoprint

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

// [F2] Motor de impresion comun a la NUBE (PrintService) y a la red del local
// (ServidorLocal). Mismo contrato que agente/lib/motor.js del .exe:
//   clave (jobId) -> Diario (ya salio? en curso?) -> ruta de la estacion ->
//   cola de ESA impresora (un hilo por destino, con tope de tiempo) ->
//   render -> IMPRIMIENDO -> bytes -> IMPRESO.
// Ruta de una estacion: asignacion hecha en ESTE equipo (Buscar impresoras)
// > transporte/destino de la nube > ip vieja (TCP) > interruptor Bluetooth
// de siempre (compatibilidad con la v1.4).
// Las estaciones de la nube se guardan (SharedPreferences) para imprimir por
// la LAN aunque el equipo arranque sin internet.
object Motor {
  data class Ruta(val transporte: String, val destino: String)
  data class Resultado(val ok: Boolean, val duplicado: Boolean = false, val via: String? = null, val error: String? = null, val dudoso: Boolean = false)

  val TRANSPORTES = listOf("TCP", "USB_WIN", "USB_ANDROID", "BT", "BLE")
  private const val P = "levoprint_motor"
  private lateinit var app: Context
  lateinit var diario: Diario
  @Volatile var estaciones: Map<String, Estacion> = emptyMap()
  @Volatile var iniciado = false
  private val ejecutores = ConcurrentHashMap<String, ExecutorService>()
  private val enCurso = ConcurrentHashMap<String, Future<Resultado>>()
  private val pendientes = ConcurrentHashMap<String, Int>()

  @Synchronized fun iniciar(ctx: Context) {
    if (iniciado) return
    app = ctx.applicationContext
    diario = Diario(File(app.filesDir, "levoprint-diario.jsonl"))
    try {
      val arr = JSONArray(app.getSharedPreferences(P, Context.MODE_PRIVATE).getString("estaciones", "[]"))
      estaciones = (0 until arr.length()).map { estacionDe(arr.getJSONObject(it)) }.associateBy { it.id }
    } catch (_: Exception) {}
    iniciado = true
  }

  fun estacionDe(e: JSONObject) = Estacion(e.optString("id"), e.optString("nombre"),
    e.optString("ip").ifBlank { null }, e.optInt("puerto", 9100),
    if (e.isNull("transporte")) null else e.optString("transporte").ifBlank { null },
    if (e.isNull("destino")) null else e.optString("destino").ifBlank { null })

  private fun guardarEstaciones() {
    val arr = JSONArray()
    for (e in estaciones.values) arr.put(JSONObject().put("id", e.id).put("nombre", e.nombre).put("ip", e.ip)
      .put("puerto", e.puerto).put("transporte", e.transporte).put("destino", e.destino))
    app.getSharedPreferences(P, Context.MODE_PRIVATE).edit().putString("estaciones", arr.toString()).apply()
  }

  // Lista de agente_config: conserva transporte/destino si esta respuesta no los trae.
  fun ponerEstaciones(nuevas: Map<String, Estacion>) {
    estaciones = nuevas.mapValues { (id, e) ->
      val prev = estaciones[id]
      if (e.transporte == null && prev?.transporte != null) e.copy(transporte = prev.transporte, destino = prev.destino) else e
    }
    guardarEstaciones()
  }

  // transporte/destino desde <p>_agente_lan.
  // [QA F2 ALTO-1] Una asignacion LOCAL ya confirmada por la nube no manda
  // para siempre: si la nube trae otra cosa (el dueno la cambio desde la app),
  // la local se descarta. Solo sobrevive la que sigue pendiente de avisar.
  fun ponerTransportes(arr: JSONArray?) {
    if (arr == null) return
    val m = estaciones.toMutableMap()
    for (i in 0 until arr.length()) {
      val t = arr.getJSONObject(i)
      val e = m[t.optString("id")] ?: continue
      val tr = if (t.isNull("transporte")) null else t.optString("transporte").ifBlank { null }
      val de = if (t.isNull("destino")) null else t.optString("destino").ifBlank { null }
      m[e.id] = e.copy(transporte = tr, destino = de)
      val a = asignacion(e.id)
      if (a != null && !a.pendienteNube && (a.ruta.transporte != tr || a.ruta.destino != de)) desasignar(e.id)
    }
    estaciones = m
    guardarEstaciones()
  }

  data class Asignacion(val ruta: Ruta, val pendienteNube: Boolean)

  // Guardada como "transporte|destino|1" (1 = pendiente de avisar a la nube).
  fun asignacion(estId: String): Asignacion? {
    val s = app.getSharedPreferences(P, Context.MODE_PRIVATE).getString("asig_$estId", null) ?: return null
    val p = s.split('|')
    if (p.size < 2 || p[0].isBlank()) return null
    return Asignacion(Ruta(p[0], p[1]), p.getOrNull(2) == "1")
  }

  // Asignacion hecha en ESTE equipo (Buscar impresoras): nace pendiente y manda
  // hasta que la nube la confirme (confirmarNube); el latido reintenta avisarla.
  fun asignar(estId: String, r: Ruta, pendienteNube: Boolean = true) {
    validar(r)?.let { throw IllegalArgumentException(it) }
    app.getSharedPreferences(P, Context.MODE_PRIVATE).edit()
      .putString("asig_$estId", r.transporte + "|" + r.destino + "|" + (if (pendienteNube) "1" else "0")).apply()
  }

  // La nube ya la tiene: se copia a la estacion y se BORRA la local (desde ahi manda la nube).
  fun confirmarNube(estId: String) {
    val a = asignacion(estId) ?: return
    estaciones[estId]?.let { e ->
      estaciones = estaciones + (estId to e.copy(transporte = a.ruta.transporte, destino = a.ruta.destino))
      guardarEstaciones()
    }
    desasignar(estId)
  }

  // La base no tiene <p>_agente_asignar o la rechazo: queda solo local, sin reintentos.
  fun quedarSoloLocal(estId: String) {
    val a = asignacion(estId) ?: return
    if (a.pendienteNube) asignar(estId, a.ruta, false)
  }

  fun pendientesNube(): List<Pair<String, Ruta>> =
    estaciones.keys.mapNotNull { id -> asignacion(id)?.takeIf { it.pendienteNube }?.let { id to it.ruta } }

  fun desasignar(estId: String) { app.getSharedPreferences(P, Context.MODE_PRIVATE).edit().remove("asig_$estId").apply() }

  // fuente: "local" (asignada en este equipo) | "nube".
  fun fuente(estId: String?): String? = when {
    estId == null -> null
    asignacion(estId) != null -> "local"
    ruta(estId) != null -> "nube"
    else -> null
  }

  fun ruta(estId: String?): Ruta? {
    if (estId == null) return null
    asignacion(estId)?.let { return it.ruta }
    val e = estaciones[estId]
    if (e?.transporte != null && e.destino != null) return Ruta(e.transporte, e.destino)
    if (e?.ip != null) return Ruta("TCP", e.ip + ":" + e.puerto)
    val mac = Prefs.getBtMac(app)
    if (Prefs.getBluetooth(app) && mac.isNotBlank()) return Ruta("BT", mac)
    return null
  }

  fun describir(r: Ruta?): String = when {
    r == null -> "sin impresora"
    r.transporte == "USB_ANDROID" -> "USB " + r.destino
    r.transporte == "BT" -> "Bluetooth " + r.destino
    else -> r.transporte + " " + r.destino
  }

  fun enCola(r: Ruta?): Int = if (r == null) 0 else (pendientes[r.transporte + "|" + r.destino] ?: 0)

  // [QA F2 MEDIO-4] UN solo punto de validacion (al asignar Y al enviar), con
  // la misma regla que el .exe (transportes.js) y la base (_il_destino_error):
  // TCP solo a IPv4 privada del local (sin 127/8 ni 169.254/16) y a puertos de
  // impresion 9100-9109. El APK no sirve de puente hacia otros servicios.
  fun validar(r: Ruta): String? {
    if (r.transporte !in TRANSPORTES) return "transporte invalido"
    if (r.destino.isBlank() || r.destino.length > 120 || r.destino.any { it.code < 32 }) return "destino invalido"
    when (r.transporte) {
      "TCP" -> {
        val i = r.destino.lastIndexOf(':')
        val ip = if (i > 0) r.destino.substring(0, i) else r.destino
        val puerto = if (i > 0) r.destino.substring(i + 1).toIntOrNull() ?: -1 else 9100
        if (!Red.esIpImpresora(ip)) return "la impresora de red debe tener una IP del local (192.168.x.x, 10.x.x.x o 172.16-31.x.x)"
        if (puerto !in 9100..9109) return "el puerto de la impresora de red debe ser 9100 (o 9101 a 9109)"
      }
      "USB_ANDROID" -> if (!Regex("^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$").matches(r.destino)) return "destino USB invalido"
      "BT" -> if (!Regex("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$").matches(r.destino)) return "destino Bluetooth invalido"
      "USB_WIN" -> return "USB de Windows solo existe en el LevoPrint de PC"
      "BLE" -> return "Bluetooth BLE todavia no esta disponible"
    }
    return null
  }

  // Mensaje para quien pidio el papel: nunca el error crudo de la red.
  fun mensajePublico(e: Throwable?): String = when {
    e is SinEnviar && e.destinoInvalido -> e.message ?: "destino invalido"
    e is SinEnviar -> "No se pudo conectar con la impresora: revisa que este encendida, con papel y en la red (o el cable)."
    else -> "La impresora no confirmo el papel. Revisa si salio antes de reintentar."
  }

  fun enviar(r: Ruta, texto: String) {
    validar(r)?.let { throw SinEnviar(it, destinoInvalido = true) }
    when (r.transporte) {
      "TCP" -> {
        val i = r.destino.lastIndexOf(':')
        val ip = if (i > 0) r.destino.substring(0, i) else r.destino
        val puerto = if (i > 0) r.destino.substring(i + 1).toIntOrNull() ?: 9100 else 9100
        Agent.imprimirTcp(ip, puerto, texto)
      }
      "BT" -> Bt.imprimir(r.destino, texto)
      "USB_ANDROID" -> Usb.imprimir(app, r.destino, Agent.bytes(texto))
      else -> throw SinEnviar("el transporte ${r.transporte} no existe en Android")
    }
  }

  private fun ejecutor(k: String): ExecutorService = ejecutores.getOrPut(k) { Executors.newSingleThreadExecutor() }

  // Imprime UN papel con dedupe por jobId|estacion. Bloquea hasta el resultado (fuera del hilo de UI).
  fun procesar(jobId: String, origen: String, estId: String?, tipo: String, payload: JSONObject, ancho: Int,
               renderRemoto: ((JSONObject) -> String?)? = null): Resultado {
    val clave = Diario.claveDe(jobId, estId)
    // Dos pedidos con la misma clave a la vez: el segundo espera al primero.
    val nuevo = java.util.concurrent.FutureTask { procesarInterno(clave, jobId, origen, estId, tipo, payload, ancho, renderRemoto) }
    val previo = enCurso.putIfAbsent(clave, nuevo)
    if (previo != null) return try { previo.get(40, TimeUnit.SECONDS).copy(duplicado = true) } catch (e: Exception) { Resultado(false, error = e.message) }
    try { nuevo.run(); return nuevo.get() } catch (e: Exception) { return Resultado(false, error = e.cause?.message ?: e.message) }
    finally { enCurso.remove(clave) }
  }

  private fun procesarInterno(clave: String, jobId: String, origen: String, estId: String?, tipo: String, payloadIn: JSONObject, ancho: Int,
                              renderRemoto: ((JSONObject) -> String?)?): Resultado {
    val previo = diario.estado(clave)
    // [QA F2 MEDIO-2] Una reimpresion PEDIDA (payload.reimpresion) no se calla.
    if (previo == "IMPRESO" && !payloadIn.optBoolean("reimpresion")) return Resultado(true, duplicado = true)
    val payload = JSONObject(payloadIn.toString())
    // DUDOSO: no se sabe si salio; si vuelve, sale con sello (no como pedido nuevo).
    val dudoso = previo == "DUDOSO"
    val job = JSONObject().put("tipo", tipo).put("payload", payload)
    val r = ruta(estId)
    if (r == null) {
      if (origen == "LAN") diario.poner(clave, e = "ERROR", o = origen, j = jobId, est = estId, t = tipo)
      return Resultado(false, error = if (estId != null && estaciones.containsKey(estId)) "estacion sin impresora asignada" else "estacion desconocida")
    }
    val k = r.transporte + "|" + r.destino
    val via = describir(r)
    val enviando = java.util.concurrent.atomic.AtomicBoolean(false)
    pendientes.merge(k, 1, Int::plus)
    val tarea = ejecutor(k).submit<Unit> {
      val base = (try { renderRemoto?.invoke(job) } catch (_: Exception) { null }) ?: Agent.render(job, ancho)
      val texto = if (dudoso) Agent.conSelloReimpresion(base) else base
      diario.poner(clave, e = "IMPRIMIENDO", o = origen, j = jobId, est = estId, t = tipo)
      enviando.set(true)
      enviar(r, texto)
    }
    return try {
      tarea.get(if (r.transporte == "USB_ANDROID" || r.transporte == "BT") 35L else 20L, TimeUnit.SECONDS)
      diario.poner(clave, e = "IMPRESO", via = via)
      Resultado(true, via = via)
    } catch (e: java.util.concurrent.TimeoutException) {
      // Impresora colgada: se descarta su hilo para que la fila siga. Si ya se
      // estaba mandando, pudo salir: DUDOSO [QA F2 MEDIO-1].
      tarea.cancel(true)
      ejecutores.remove(k)?.shutdownNow()
      val d = enviando.get()
      diario.poner(clave, e = if (d) "DUDOSO" else "ERROR", o = origen, j = jobId, est = estId, t = tipo)
      Resultado(false, via = via, error = mensajePublico(null), dudoso = d)
    } catch (e: Exception) {
      val causa = e.cause ?: e
      val d = enviando.get() && causa !is SinEnviar
      diario.poner(clave, e = if (d) "DUDOSO" else "ERROR", o = origen, j = jobId, est = estId, t = tipo)
      PrintService.ultimoLog = "ERR " + via + ": " + causa.message
      Resultado(false, via = via, error = mensajePublico(causa), dudoso = d)
    } finally {
      pendientes.computeIfPresent(k) { _, n -> if (n <= 1) null else n - 1 }
    }
  }
}

// [QA F2 MEDIO-1] Falla en la que es SEGURO que la impresora no recibio nada
// (no conecto, no hay permiso, destino invalido): reintentar sale sin sello.
class SinEnviar(mensaje: String, val destinoInvalido: Boolean = false, causa: Throwable? = null) : RuntimeException(mensaje, causa)
