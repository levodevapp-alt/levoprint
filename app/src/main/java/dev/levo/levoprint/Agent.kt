package dev.levo.levoprint

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

// Config de emparejamiento: el mismo APK sirve para cualquier app de
// LevoDev cambiando el prefijo (komo -> komo_*, otra -> otra_*).
data class Cfg(
  val url: String, val anon: String, val device: String,
  val prefijo: String, val ancho: Int
)

data class Estacion(val id: String, val nombre: String, val ip: String?, val puerto: Int)

object Agent {
  // ESC/POS construido con codigos de caracter (sin bytes de control
  // crudos en el fuente). ESC=27, GS=29, NL=10.
  private val ESC = 27.toChar().toString()
  private val GS = 29.toChar().toString()
  private val NL = 10.toChar().toString()
  private val INIT = ESC + "@"
  private val CENTRO = ESC + "a" + 1.toChar()
  private val IZQ = ESC + "a" + 0.toChar()
  private val NEG_ON = ESC + "E" + 1.toChar()
  private val NEG_OFF = ESC + "E" + 0.toChar()
  private val GRANDE = GS + "!" + 17.toChar()
  private val NORMAL = GS + "!" + 0.toChar()
  private val CORTE = NL + NL + NL + GS + "V" + 0.toChar()
  private val PIE = "Hecho con carino en Paracas" + NL + "<Levo.dev />" + NL

  // ---- RPC (mismo contrato que el agente .exe) ----
  fun rpc(c: Cfg, fn: String, p: JSONObject): JSONObject {
    val u = URL(c.url.trimEnd('/') + "/rest/v1/rpc/" + fn)
    val con = u.openConnection() as HttpURLConnection
    con.requestMethod = "POST"
    con.connectTimeout = 8000
    con.readTimeout = 12000
    con.setRequestProperty("apikey", c.anon)
    con.setRequestProperty("Authorization", "Bearer " + c.anon)
    con.setRequestProperty("Content-Type", "application/json")
    con.doOutput = true
    con.outputStream.use { it.write(JSONObject().put("p", p).toString().toByteArray(Charsets.UTF_8)) }
    val code = con.responseCode
    val s = if (code in 200..299) con.inputStream else con.errorStream
    val txt = s?.bufferedReader()?.use { r -> r.readText() } ?: ""
    con.disconnect()
    if (code !in 200..299) throw RuntimeException(fn + " HTTP " + code + ": " + txt.take(180))
    return if (txt.isBlank()) JSONObject() else JSONObject(txt)
  }

  fun estaciones(c: Cfg): Map<String, Estacion> {
    val r = rpc(c, c.prefijo + "_agente_config", JSONObject().put("device", c.device))
    val arr = r.optJSONArray("estaciones") ?: JSONArray()
    val m = HashMap<String, Estacion>()
    for (i in 0 until arr.length()) {
      val e = arr.getJSONObject(i)
      val id = e.optString("id")
      m[id] = Estacion(id, e.optString("nombre"), e.optString("ip").ifBlank { null }, e.optInt("puerto", 9100))
    }
    return m
  }

  fun tomar(c: Cfg): JSONArray {
    val r = rpc(c, c.prefijo + "_print_tomar", JSONObject().put("device", c.device).put("limite", 10))
    return r.optJSONArray("jobs") ?: JSONArray()
  }

  fun marcar(c: Cfg, id: String, ok: Boolean, error: String? = null) {
    val p = JSONObject().put("device", c.device).put("id", id).put("ok", ok)
    if (error != null) p.put("error", error)
    rpc(c, c.prefijo + "_print_marcar", p)
  }

  // ---- ESC/POS (mismo formato que el agente) ----
  private fun linea(ancho: Int, ch: String = "-") = ch.repeat(ancho) + NL
  private fun fila(izq: String, der: String, ancho: Int): String {
    val esp = maxOf(1, ancho - izq.length - der.length)
    return izq + " ".repeat(esp) + der + NL
  }
  private fun money(n: Double) = "S/ " + String.format("%.2f", n)
  private fun cant(n: Double) = if (n % 1.0 == 0.0) n.toInt().toString() else String.format("%.3f", n)
  private fun items(pl: JSONObject): JSONArray = pl.optJSONArray("items") ?: JSONArray()

  private fun renderComanda(pl: JSONObject, ancho: Int): String {
    val titulo = if (pl.optBoolean("correccion")) "*** CORRECCION ***" else "COMANDA"
    val b = StringBuilder(INIT + CENTRO + GRANDE + titulo + NL + NORMAL)
    b.append(GRANDE + "MESA " + pl.optString("mesa") + NL + NORMAL + IZQ + linea(ancho, "="))
    b.append(fila("Mozo: " + pl.optString("mozo", "-"), pl.optString("hora", ""), ancho))
    if (pl.optInt("ronda") > 0) b.append(fila("Ronda " + pl.optInt("ronda"), "", ancho))
    b.append(linea(ancho, "="))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(NEG_ON + cant(it.optDouble("cantidad", 1.0)) + " x " + it.optString("nombre") + NL + NEG_OFF)
      val nota = it.optString("nota")
      if (nota.isNotBlank()) b.append("   >> " + nota + NL)
    }
    val nota = pl.optString("nota")
    if (nota.isNotBlank()) b.append(linea(ancho) + "NOTA: " + nota + NL)
    b.append(linea(ancho, "=") + CENTRO + NORMAL + PIE + CORTE)
    return b.toString()
  }

  private fun renderPrecuenta(pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + "PRECUENTA" + NL + NORMAL)
    b.append("MESA " + pl.optString("mesa") + NL + IZQ + linea(ancho, "="))
    b.append(fila("Mozo: " + pl.optString("mozo", "-"), pl.optString("hora", ""), ancho) + linea(ancho))
    val its = items(pl)
    var total = 0.0
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      val sub = it.optDouble("cantidad", 0.0) * it.optDouble("precio", 0.0)
      total += sub
      b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + it.optString("nombre")).take(ancho - 9), money(sub), ancho))
    }
    val tot = if (pl.has("total")) pl.optDouble("total") else total
    b.append(linea(ancho, "=") + NEG_ON + fila("TOTAL", money(tot), ancho) + NEG_OFF + linea(ancho, "="))
    b.append(CENTRO + "[QR] " + pl.optString("qr") + NL + "NO ES COMPROBANTE DE PAGO" + NL + PIE + CORTE)
    return b.toString()
  }

  private fun renderGenerico(tipo: String, pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + tipo + NL + NORMAL + IZQ + linea(ancho, "="))
    if (pl.has("numero")) b.append(fila("Numero", pl.optString("numero"), ancho))
    if (pl.has("mesa")) b.append(fila("Mesa", pl.optString("mesa"), ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      val nombre = it.optString("nombre")
      if (it.has("precio")) b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + nombre).take(ancho - 9),
        money(it.optDouble("cantidad", 1.0) * it.optDouble("precio", 0.0)), ancho))
      else b.append(cant(it.optDouble("cantidad", 1.0)) + " x " + nombre + NL)
    }
    if (pl.has("total")) b.append(linea(ancho, "=") + NEG_ON + fila("TOTAL", money(pl.optDouble("total")), ancho) + NEG_OFF)
    b.append(linea(ancho, "=") + CENTRO + PIE + CORTE)
    return b.toString()
  }

  fun render(job: JSONObject, ancho: Int): String {
    val tipo = job.optString("tipo")
    val pl = job.optJSONObject("payload") ?: JSONObject()
    return when (tipo) {
      "PRUEBA" -> INIT + CENTRO + "PRUEBA LEVOPRINT OK" + NL + PIE + CORTE
      "COMANDA" -> renderComanda(pl, ancho)
      "PRECUENTA" -> renderPrecuenta(pl, ancho)
      else -> renderGenerico(tipo.ifBlank { "COMPROBANTE" }, pl, ancho)
    }
  }

  // ---- Impresion por TCP (impresora de red ESC/POS :9100) ----
  fun imprimir(ip: String, puerto: Int, texto: String) {
    Socket().use { s ->
      s.connect(InetSocketAddress(ip, puerto), 5000)
      s.getOutputStream().use { out ->
        out.write(texto.toByteArray(Charsets.UTF_8))
        out.flush()
      }
    }
  }
}
