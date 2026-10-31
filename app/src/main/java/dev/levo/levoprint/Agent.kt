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

// [F2] transporte/destino: columnas nuevas (plantilla impresion_local). Nulos =
// estacion de siempre (ip:puerto por TCP).
data class Estacion(val id: String, val nombre: String, val ip: String?, val puerto: Int,
                    val transporte: String? = null, val destino: String? = null)

// [canje-v3] Error HTTP de una RPC con el "message" de Postgres ya leido.
// Las RPC del agente (agente_config / print_tomar / print_marcar) pasan por
// __SCHEMA__._agente(device), que hace raise 'AGENTE_INVALIDO' si el token no
// existe o el dispositivo esta inactivo (p. ej. lo REEMPLAZO otro equipo al
// conectarse). PostgREST lo devuelve como HTTP 400 {"message":"AGENTE_INVALIDO"}.
class RpcError(val fn: String, val http: Int, val pgMensaje: String, cuerpo: String) :
  RuntimeException(fn + " HTTP " + http + ": " + cuerpo.take(180)) {
  val agenteInvalido: Boolean get() = pgMensaje == "AGENTE_INVALIDO"
}

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
    if (code !in 200..299) {
      val pg = try { JSONObject(txt).optString("message") } catch (_: Exception) { "" }
      throw RpcError(fn, code, pg.trim(), txt)
    }
    return if (txt.isBlank()) JSONObject() else JSONObject(txt)
  }

  fun estaciones(c: Cfg): Map<String, Estacion> {
    val r = rpc(c, c.prefijo + "_agente_config", JSONObject().put("device", c.device))
    val arr = r.optJSONArray("estaciones") ?: JSONArray()
    val m = HashMap<String, Estacion>()
    for (i in 0 until arr.length()) {
      val e = Motor.estacionDe(arr.getJSONObject(i))
      m[e.id] = e
    }
    return m
  }

  // [F2] Latido LAN: publica la IP del equipo en la red del local, trae
  // transporte/destino de cada estacion y reporta lo impreso por la LAN.
  // Si la base aun no tiene la RPC (plantilla impresion_local), RpcError 404.
  fun latidoLan(c: Cfg, ips: List<String>, puerto: Int, impresos: List<Diario.Entrada>): JSONObject {
    val arr = JSONArray()
    for (x in impresos) arr.put(JSONObject().put("clave", x.k).put("estacion", x.est).put("ts", java.time.Instant.ofEpochMilli(x.ts).toString()))
    val p = JSONObject().put("device", c.device).put("version", BuildConfig.VERSION_NAME).put("android", true)
      .put("lan", JSONObject().put("ips", JSONArray(ips)).put("puerto", puerto)).put("impresos", arr)
    return rpc(c, c.prefijo + "_agente_lan", p)
  }

  fun asignar(c: Cfg, estacion: String, transporte: String, destino: String) {
    rpc(c, c.prefijo + "_agente_asignar", JSONObject().put("device", c.device).put("estacion", estacion)
      .put("transporte", transporte).put("destino", destino))
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
  private fun money(n: Double) = "S/ " + String.format(java.util.Locale.US, "%.2f", n)
  private fun cant(n: Double) = if (n % 1.0 == 0.0) n.toInt().toString() else String.format(java.util.Locale.US, "%.3f", n)
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
    // [kuti] KUTI manda "refTipo" (KOMO/KIPU no): su nota de venta va aparte y
    // lo de KOMO/KIPU sale byte a byte igual que antes (AgentRenderTest).
    if (pl.has("refTipo")) return renderTicketKuti(pl, ancho)
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

  // Texto de un campo que puede venir null en el JSON (optString daria "null").
  private fun txt(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.optString(k)

  // [kuti] Nota de venta de KUTI (misma forma que la rama retail del .exe):
  // negocio, local, VENTA o ALQUILER DE SILLA, nota, quien atendio, cliente
  // (en alquiler, el profesional), servicios con su profesional en una segunda
  // linea, TOTAL, pagos y propinas APARTE (no suman al total).
  private fun renderTicketKuti(pl: JSONObject, ancho: Int): String {
    val b = StringBuilder(INIT + CENTRO)
    if (txt(pl, "negocio").isNotBlank()) b.append(NEG_ON + GRANDE + txt(pl, "negocio").uppercase() + NL + NORMAL + NEG_OFF)
    if (txt(pl, "local").isNotBlank()) b.append(txt(pl, "local") + NL)
    b.append(GRANDE + (if (txt(pl, "refTipo") == "ALQUILER") "ALQUILER DE SILLA" else "VENTA") + NL + NORMAL)
    b.append(IZQ + linea(ancho, "="))
    if (txt(pl, "nota").isNotBlank()) b.append("Nota: " + txt(pl, "nota") + NL)
    val quien = txt(pl, "vendedor")
    b.append(fila(if (quien.isNotBlank()) "Atendio: " + quien else "", txt(pl, "hora"), ancho))
    if (txt(pl, "cliente").isNotBlank()) b.append("Cliente: " + txt(pl, "cliente") + NL)
    b.append(linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(fila((cant(it.optDouble("cantidad", 1.0)) + " " + txt(it, "nombre")).take(ancho - 9),
        money(it.optDouble("cantidad", 1.0) * it.optDouble("precio", 0.0)), ancho))
      if (txt(it, "profesional").isNotBlank()) b.append("   - " + txt(it, "profesional") + NL)
    }
    b.append(linea(ancho, "=") + NEG_ON + fila("TOTAL", money(pl.optDouble("total", 0.0)), ancho) + NEG_OFF)
    val pg = pagos(pl)
    for (i in 0 until pg.length()) {
      val p = pg.getJSONObject(i)
      b.append(fila("  " + txt(p, "medio"), money(p.optDouble("monto", 0.0)), ancho))
    }
    val pr = pl.optJSONArray("propinas") ?: JSONArray()
    if (pr.length() > 0) {
      b.append(linea(ancho) + "PROPINAS (aparte, no suman al total)" + NL)
      for (i in 0 until pr.length()) {
        val p = pr.getJSONObject(i)
        b.append(fila(("  " + txt(p, "profesional") + " (" + txt(p, "medio") + ")").take(ancho - 12), money(p.optDouble("monto", 0.0)), ancho))
      }
    }
    b.append(linea(ancho, "=") + CENTRO + "NO ES COMPROBANTE DE PAGO" + NL + PIE)
    return b.toString()
  }

  // [kuti] Corte de caja: las lineas {izq, der, sep, negrita} ya vienen formateadas
  // desde la base. Sin "lineas" (KOMO/KIPU) sigue el render generico de siempre.
  private fun renderCierre(pl: JSONObject, ancho: Int): String {
    val ls = pl.optJSONArray("lineas") ?: return renderGenerico("CIERRE", pl, ancho)
    val b = StringBuilder(INIT + CENTRO)
    if (pl.optString("negocio").isNotBlank()) b.append(NEG_ON + pl.optString("negocio").uppercase() + NL + NEG_OFF)
    b.append(GRANDE + "CORTE DE CAJA" + NL + NORMAL + IZQ + linea(ancho, "="))
    for (i in 0 until ls.length()) {
      val l = ls.optJSONObject(i) ?: continue
      if (l.optString("sep").isNotBlank()) { b.append(linea(ancho, l.optString("sep").take(1))); continue }
      val der = l.optString("der")
      val f = fila(l.optString("izq").take(maxOf(1, ancho - der.length - 1)), der, ancho)
      b.append(if (l.optBoolean("negrita")) NEG_ON + f + NEG_OFF else f)
    }
    b.append(linea(ancho, "=") + CENTRO + PIE)
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
    val t = when (tipo) {
      "PRUEBA" -> INIT + CENTRO + "PRUEBA LEVOPRINT OK" + NL + PIE
      "COMANDA" -> renderComanda(pl, ancho)
      "PRECUENTA" -> renderPrecuenta(pl, ancho)
      "TICKET" -> renderTicket(pl, ancho)
      "CPE" -> renderCpe(pl, ancho)
      "CARTA_QR" -> renderCartaQr(pl, ancho)
      "CIERRE" -> renderCierre(pl, ancho)
      else -> renderGenerico(tipo.ifBlank { "COMPROBANTE" }, pl, ancho)
    }
    // [kuti] Toda reimpresion de KUTI trae "copia": sello arriba. KOMO/KIPU no lo mandan.
    // [F2] "reimpresion" (como el .exe): sello REIMPRESION arriba; lo usa el
    // diario cuando un trabajo quedo DUDOSO (la app murio a mitad).
    if (!pl.optBoolean("copia") && pl.optBoolean("reimpresion") && t.startsWith(INIT))
      return INIT + CENTRO + NEG_ON + "*** REIMPRESION ***" + NL + NEG_OFF + IZQ + t.substring(INIT.length)
    if (!pl.optBoolean("copia") || !t.startsWith(INIT)) return t
    return INIT + CENTRO + NEG_ON + GRANDE + "*** COPIA ***" + NL + NORMAL + NEG_OFF + IZQ + t.substring(INIT.length)
  }

  // Bytes a enviar a la impresora: latin1 (ISO-8859-1), como el .exe.
  fun bytes(texto: String): ByteArray = texto.toByteArray(Charsets.ISO_8859_1)

  // ---- Impresion por TCP (impresora de red ESC/POS :9100) ----
  fun imprimirTcp(ip: String, puerto: Int, texto: String) {
    Socket().use { s ->
      s.connect(InetSocketAddress(ip, puerto), 5000)
      s.soTimeout = 10000
      s.getOutputStream().use { out ->
        out.write(bytes(texto))
        out.flush()
      }
    }
  }
}
