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
  data class Resultado(val ok: Boolean, val duplicado: Boolean = false, val via: String? = null, val error: String? = null)

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
  fun ponerTransportes(arr: JSONArray?) {
    if (arr == null) return
    val m = estaciones.toMutableMap()
    for (i in 0 until arr.length()) {
      val t = arr.getJSONObject(i)
      val e = m[t.optString("id")] ?: continue
      m[e.id] = e.copy(transporte = if (t.isNull("transporte")) null else t.optString("transporte").ifBlank { null },
        destino = if (t.isNull("destino")) null else t.optString("destino").ifBlank { null })
    }
    estaciones = m
    guardarEstaciones()
  }

  fun asignacion(estId: String): Ruta? {
    val s = app.getSharedPreferences(P, Context.MODE_PRIVATE).getString("asig_$estId", null) ?: return null
    val i = s.indexOf('|'); if (i <= 0) return null
    return Ruta(s.substring(0, i), s.substring(i + 1))
  }

  fun asignar(estId: String, r: Ruta) {
    require(r.transporte in TRANSPORTES) { "transporte invalido" }
    app.getSharedPreferences(P, Context.MODE_PRIVATE).edit().putString("asig_$estId", r.transporte + "|" + r.destino).apply()
  }

  fun desasignar(estId: String) { app.getSharedPreferences(P, Context.MODE_PRIVATE).edit().remove("asig_$estId").apply() }

  fun ruta(estId: String?): Ruta? {
    if (estId == null) return null
    asignacion(estId)?.let { return it }
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

  // Destino que se acepta tocar: TCP solo a IP privada (no somos un puente a internet).
  fun validar(r: Ruta): String? {
    if (r.transporte !in TRANSPORTES) return "transporte invalido"
    if (r.destino.isBlank() || r.destino.length > 120) return "destino invalido"
    if (r.transporte == "TCP") {
      val ip = r.destino.substringBeforeLast(':')
      if (!Red.esIpPrivada(ip)) return "la impresora de red debe tener una IP del local"
    }
    if (r.transporte == "USB_WIN") return "USB de Windows solo existe en el LevoPrint de PC"
    if (r.transporte == "BLE") return "Bluetooth BLE todavia no esta disponible"
    return null
  }

  fun enviar(r: Ruta, texto: String) {
    when (r.transporte) {
      "TCP" -> {
        val i = r.destino.lastIndexOf(':')
        val ip = if (i > 0) r.destino.substring(0, i) else r.destino
        val puerto = if (i > 0) r.destino.substring(i + 1).toIntOrNull() ?: 9100 else 9100
        Agent.imprimirTcp(ip, puerto, texto)
      }
      "BT" -> Bt.imprimir(r.destino, texto)
      "USB_ANDROID" -> Usb.imprimir(app, r.destino, Agent.bytes(texto))
      else -> throw RuntimeException("el transporte ${r.transporte} no existe en Android")
    }
  }

  private fun ejecutor(k: String): ExecutorService = ejecutores.getOrPut(k) { Executors.newSingleThreadExecutor() }

  // Imprime UN trabajo con dedupe. Bloquea hasta el resultado (llamar fuera del hilo de UI).
  fun procesar(clave: String, origen: String, estId: String?, tipo: String, payload: JSONObject, ancho: Int,
               renderRemoto: ((JSONObject) -> String?)? = null): Resultado {
    // Dos pedidos con la misma clave a la vez: el segundo espera al primero.
    val nuevo = java.util.concurrent.FutureTask { procesarInterno(clave, origen, estId, tipo, payload, ancho, renderRemoto) }
    val previo = enCurso.putIfAbsent(clave, nuevo)
    if (previo != null) return try { previo.get(40, TimeUnit.SECONDS).copy(duplicado = true) } catch (e: Exception) { Resultado(false, error = e.message) }
    try { nuevo.run(); return nuevo.get() } catch (e: Exception) { return Resultado(false, error = e.cause?.message ?: e.message) }
    finally { enCurso.remove(clave) }
  }

  private fun procesarInterno(clave: String, origen: String, estId: String?, tipo: String, payloadIn: JSONObject, ancho: Int,
                              renderRemoto: ((JSONObject) -> String?)?): Resultado {
    val previo = diario.estado(clave)
    if (previo == "IMPRESO") return Resultado(true, duplicado = true)
    val payload = JSONObject(payloadIn.toString())
    // DUDOSO: la app murio a mitad; si vuelve, sale con sello (no como pedido nuevo).
    val dudoso = previo == "DUDOSO"
    val job = JSONObject().put("tipo", tipo).put("payload", payload)
    val r = ruta(estId)
    if (r == null) {
      if (origen == "LAN") diario.poner(clave, e = "ERROR", o = origen, est = estId, t = tipo)
      return Resultado(false, error = if (estId != null && estaciones.containsKey(estId)) "estacion sin impresora asignada" else "estacion desconocida")
    }
    val k = r.transporte + "|" + r.destino
    val via = describir(r)
    pendientes.merge(k, 1, Int::plus)
    val tarea = ejecutor(k).submit<Unit> {
      val base = (try { renderRemoto?.invoke(job) } catch (_: Exception) { null }) ?: Agent.render(job, ancho)
      val texto = if (dudoso) Agent.conSelloReimpresion(base) else base
      diario.poner(clave, e = "IMPRIMIENDO", o = origen, est = estId, t = tipo)
      enviar(r, texto)
    }
    return try {
      tarea.get(if (r.transporte == "USB_ANDROID" || r.transporte == "BT") 35L else 20L, TimeUnit.SECONDS)
      diario.poner(clave, e = "IMPRESO", via = via)
      Resultado(true, via = via)
    } catch (e: java.util.concurrent.TimeoutException) {
      // Impresora colgada: se descarta su hilo para que la fila siga.
      tarea.cancel(true)
      ejecutores.remove(k)?.shutdownNow()
      diario.poner(clave, e = "ERROR", o = origen, est = estId, t = tipo)
      Resultado(false, via = via, error = "la impresora no respondio a tiempo")
    } catch (e: Exception) {
      diario.poner(clave, e = "ERROR", o = origen, est = estId, t = tipo)
      Resultado(false, via = via, error = e.cause?.message ?: e.message)
    } finally {
      pendientes.computeIfPresent(k) { _, n -> if (n <= 1) null else n - 1 }
    }
  }
}
