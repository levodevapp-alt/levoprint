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
  // ESC/POS con codigos de caracter (sin bytes de control crudos en el
  // fuente). Se construye TODO como String de chars 0..255 y se envia en
  // latin1 (ISO-8859-1), igual que el agente .exe (Buffer 'binary').
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
  private val FONT0 = ESC + "!" + 0.toChar()
  private val CORTE = NL + NL + NL + GS + "V" + 0.toChar()
  private val PIE = FONT0 + "Hecho con carino en Paracas" + NL + "<Levo.dev />" + NL + CORTE

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

  // ---- ESC/POS (mismo formato que el agente .exe) ----
  private fun linea(ancho: Int, ch: String = "-") = ch.repeat(ancho) + NL
  private fun fila(izq: String, der: String, ancho: Int): String {
    val esp = maxOf(1, ancho - izq.length - der.length)
    return izq + " ".repeat(esp) + der + NL
  }
  private fun money(n: Double) = "S/ " + String.format("%.2f", n)
  private fun cant(n: Double) = if (n % 1.0 == 0.0) n.toInt().toString() else String.format("%.3f", n)
  private fun items(pl: JSONObject): JSONArray = pl.optJSONArray("items") ?: JSONArray()
  private fun pagos(pl: JSONObject): JSONArray = pl.optJSONArray("pagos") ?: JSONArray()
  private fun n(x: Double) = x

  // QR grafico ESC/POS (GS ( k, modelo 2). Los bytes 0..255 van como chars
  // y se serializan en latin1 al imprimir.
  private fun qr(texto: String, tam: Int = 5): String {
    val data = texto.toByteArray(Charsets.UTF_8)
    val len = data.size + 3
    val pL = (len and 0xff).toChar()
    val pH = ((len shr 8) and 0xff).toChar()
    val b = StringBuilder()
    b.append(GS).append("(k").append(4.toChar()).append(0.toChar()).append('1').append('A').append('2').append(0.toChar())
    b.append(GS).append("(k").append(3.toChar()).append(0.toChar()).append('1').append('C').append(tam.toChar())
    b.append(GS).append("(k").append(3.toChar()).append(0.toChar()).append('1').append('E').append('1')
    b.append(GS).append("(k").append(pL).append(pH).append('1').append('P').append('0')
    for (by in data) b.append((by.toInt() and 0xff).toChar())
    b.append(GS).append("(k").append(3.toChar()).append(0.toChar()).append('1').append('Q').append('0')
    return b.toString()
  }

  private fun renderComanda(pl: JSONObject, ancho: Int): String {
    val titulo = if (pl.optBoolean("correccion")) "*** CORRECCION ***" else "COMANDA"
    val b = StringBuilder(INIT + CENTRO + GRANDE + titulo + NL + NORMAL)
    b.append(GRANDE + "MESA " + pl.optString("mesa") + NL + NORMAL + IZQ + linea(ancho, "="))
    b.append(fila("Mozo: " + pl.optString("mozo", "-"), pl.optString("hora", ""), ancho))
    if (pl.optInt("ronda") > 0) b.append(fila("Ronda " + pl.optInt("ronda"), "", ancho))
    b.append(linea(ancho, "="))
    if (pl.optString("mensaje").isNotBlank())
      b.append(NEG_ON + GRANDE + pl.optString("mensaje") + NL + NORMAL + NEG_OFF + linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(NEG_ON + cant(it.optDouble("cantidad", 1.0)) + " x " + it.optString("nombre") + NL + NEG_OFF)
      val nota = it.optString("nota")
      if (nota.isNotBlank()) b.append("   >> " + nota + NL)
    }
    val nota = pl.optString("nota")
    if (nota.isNotBlank()) b.append(linea(ancho) + "NOTA: " + nota + NL)
    b.append(linea(ancho, "=") + CENTRO + PIE)
    return b.toString()
  }

  private fun renderPrecuenta(pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + "PRECUENTA" + NL + NORMAL)
    b.append("MESA " + pl.optString("mesa") + NL)
    val c = pl.optJSONObject("cuenta")
    if (c != null && c.has("de")) b.append(NEG_ON + "CUENTA " + c.optString("n") + " de " + c.optString("de") + NL + NEG_OFF)
    b.append(IZQ + linea(ancho, "="))
    b.append(fila("Mozo: " + pl.optString("mozo", "-"), pl.optString("hora", ""), ancho) + linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + it.optString("nombre")).take(ancho - 9),
        money(it.optDouble("cantidad", 1.0) * it.optDouble("precio", 0.0)), ancho))
    }
    b.append(linea(ancho, "=") + NEG_ON + fila("TOTAL", money(pl.optDouble("total", 0.0)), ancho) + NEG_OFF + linea(ancho, "="))
    b.append(CENTRO + "[QR] " + pl.optString("qr") + NL + "NO ES COMPROBANTE DE PAGO" + NL + PIE)
    return b.toString()
  }

  private fun renderTicket(pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + "COBRADO" + NL + NORMAL)
    b.append("MESA " + pl.optString("mesa", "-") + NL + IZQ + linea(ancho, "="))
    b.append(fila("Mozo: " + pl.optString("mozo", "-"), pl.optString("hora", ""), ancho) + linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + it.optString("nombre")).take(ancho - 9),
        money(it.optDouble("cantidad", 1.0) * it.optDouble("precio", 0.0)), ancho))
    }
    b.append(linea(ancho, "=") + NEG_ON + fila("TOTAL", money(pl.optDouble("total", 0.0)), ancho) + NEG_OFF)
    val pg = pagos(pl)
    for (i in 0 until pg.length()) {
      val p = pg.getJSONObject(i)
      b.append(fila("  " + p.optString("medio"), money(p.optDouble("monto", 0.0)), ancho))
    }
    b.append(linea(ancho, "=") + CENTRO + "NO ES COMPROBANTE DE PAGO" + NL + PIE)
    return b.toString()
  }

  private fun renderCpe(pl: JSONObject, ancho: Int): String {
    val e = pl.optJSONObject("empresa") ?: JSONObject()
    val cl = pl.optJSONObject("cliente") ?: JSONObject()
    val tot = pl.optJSONObject("totales") ?: JSONObject()
    val numero = pl.optString("serie") + "-" + pl.optString("numero").padStart(8, '0')
    val b = StringBuilder(INIT + CENTRO + NEG_ON + (e.optString("razonSocial").ifBlank { e.optString("nombre") }) + NL + NEG_OFF)
    if (e.optString("ruc").isNotBlank()) b.append("RUC " + e.optString("ruc") + NL)
    if (e.optString("direccion").isNotBlank()) b.append(e.optString("direccion") + NL)
    b.append(linea(ancho, "=") + NEG_ON + pl.optString("tipo", "COMPROBANTE") + NL + GRANDE + numero + NL + NORMAL + NEG_OFF)
    if (pl.optString("estado") == "STUB") b.append("*** MODO PRACTICA - SIN VALOR ***" + NL)
    b.append(IZQ + linea(ancho, "="))
    b.append(fila("Fecha: " + pl.optString("fecha"), "", ancho))
    if (pl.optString("mesa").isNotBlank()) b.append(fila("Mesa: " + pl.optString("mesa"), if (pl.optString("mozo").isNotBlank()) "Mozo: " + pl.optString("mozo") else "", ancho))
    b.append("Cliente: " + (cl.optString("nombre").ifBlank { "CLIENTE VARIOS" }) + NL)
    if (cl.optString("doc").isNotBlank() && cl.optString("doc") != "0") b.append(cl.optString("tipoDoc", "DOC") + ": " + cl.optString("doc") + NL)
    if (cl.optString("direccion").isNotBlank()) b.append(cl.optString("direccion") + NL)
    b.append(linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + it.optString("nombre")).take(ancho - 10), money(it.optDouble("total", 0.0)), ancho))
    }
    b.append(linea(ancho))
    if (n(tot.optDouble("gravada", 0.0)) > 0) b.append(fila("OP. GRAVADA", money(tot.optDouble("gravada")), ancho))
    if (n(tot.optDouble("exonerada", 0.0)) > 0) b.append(fila("OP. EXONERADA", money(tot.optDouble("exonerada")), ancho))
    if (n(tot.optDouble("inafecta", 0.0)) > 0) b.append(fila("OP. INAFECTA", money(tot.optDouble("inafecta")), ancho))
    if (n(tot.optDouble("igv", 0.0)) > 0) b.append(fila("IGV 18%", money(tot.optDouble("igv")), ancho))
    b.append(NEG_ON + fila("TOTAL", money(pl.optDouble("total", 0.0)), ancho) + NEG_OFF)
    val pg = pagos(pl)
    for (i in 0 until pg.length()) {
      val p = pg.getJSONObject(i)
      b.append(fila("  " + p.optString("medio"), money(p.optDouble("monto", 0.0)), ancho))
    }
    b.append(linea(ancho, "=") + CENTRO)
    if (pl.optString("qr").isNotBlank()) b.append(qr(pl.optString("qr")) + NL)
    if (pl.optString("hash").isNotBlank()) b.append("Hash: " + pl.optString("hash").take(28) + NL)
    b.append("Representacion impresa del" + NL + "comprobante electronico." + NL + "Consulte en sunat.gob.pe" + NL + PIE)
    return b.toString()
  }

  private fun renderCartaQr(pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + NEG_ON + GRANDE + pl.optString("titulo") + NL + NORMAL + NEG_OFF)
    b.append(FONT0 + (pl.optString("sub").ifBlank { "Escanea nuestra carta" }) + NL + NL)
    if (pl.optString("url").isNotBlank()) b.append(qr(pl.optString("url"), 8) + NL)
    b.append(FONT0 + pl.optString("url") + NL + PIE)
    return b.toString()
  }

  private fun renderGenerico(tipo: String, pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + tipo + NL + NORMAL + IZQ + linea(ancho, "="))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(cant(it.optDouble("cantidad", 1.0)) + " x " + it.optString("nombre") + NL)
    }
    b.append(linea(ancho, "=") + CENTRO + PIE)
    return b.toString()
  }

  fun render(job: JSONObject, ancho: Int): String {
    val tipo = job.optString("tipo")
    val pl = job.optJSONObject("payload") ?: JSONObject()
    return when (tipo) {
      "PRUEBA" -> INIT + CENTRO + "PRUEBA LEVOPRINT OK" + NL + PIE
      "COMANDA" -> renderComanda(pl, ancho)
      "PRECUENTA" -> renderPrecuenta(pl, ancho)
      "TICKET" -> renderTicket(pl, ancho)
      "CPE" -> renderCpe(pl, ancho)
      "CARTA_QR" -> renderCartaQr(pl, ancho)
      else -> renderGenerico(tipo.ifBlank { "COMPROBANTE" }, pl, ancho)
    }
  }

  // Bytes a enviar a la impresora: latin1 (ISO-8859-1), como el .exe.
  fun bytes(texto: String): ByteArray = texto.toByteArray(Charsets.ISO_8859_1)

  // ---- Impresion por TCP (impresora de red ESC/POS :9100) ----
  fun imprimirTcp(ip: String, puerto: Int, texto: String) {
    Socket().use { s ->
      s.connect(InetSocketAddress(ip, puerto), 5000)
      s.getOutputStream().use { out ->
        out.write(bytes(texto))
        out.flush()
      }
    }
  }
}
