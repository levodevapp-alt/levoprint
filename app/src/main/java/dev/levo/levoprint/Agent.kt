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
  // [O-23 · QA MEDIO-2] Versión de este APK (= versionName de app/build.gradle.kts; AgentRenderTest lo comprueba).
  // Va en <prefijo>_agente_config (p.version = "apk/1.5.0"): KUTI (kuti_turno_print) solo manda el papel TURNO a un
  // local cuyos agentes vivos lo saben dibujar. KOMO/KIPU la ignoran.
  const val VERSION = "1.5.0"
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
  // [O-23] triple de ancho y alto (GS ! 0x22): el numero del turno se lee desde lejos
  private val ENORME = GS + "!" + 34.toChar()
  private val FONT0 = ESC + "!" + 0.toChar()
  private val CORTE = NL + NL + NL + GS + "V" + 0.toChar()
  // [MM3-01 · MM3-P1 · 4-nov] Pie de marca del ticket termico (IDENTIDAD_VISUAL 12.12). El ticket es del
  // NEGOCIO del cliente (su nombre va arriba); LevoDev va discreta al pie: isotipo D2 Yupana en 1 bit
  // (64x64 puntos, GS v 0; mapa generado por levodev-modules/tools/marca/isotipo_termico.mjs, el mismo
  // del .exe de LevoPrint, el de KOMO y las Edge *-print) + "Hecho con <APP> - levodev.app" + el lema
  // "Tu negocio, inteligente y bajo control.". Sin ciudades, sin pais, sin precios, sin invitacion
  // (MM3-P5: la invitacion va solo en el ticket digital). ASCII PURO [QA MM3 M1]: guion y no el punto
  // medio 0xB7 ni tildes, que dependen de la pagina de codigos de la impresora. El nombre de la app sale
  // de la configuracion del local (KOMO, KIPU o KUTI); prefijo desconocido -> "LevoDev - levodev.app".
  // Bajo 40 columnas (58 mm) el lema va en dos lineas. Impresora sin soporte de imagen: el interruptor
  // "Pie con logo" (Prefs.getImagen) o payload.sinImagen -> las mismas lineas salen solo en texto.
  private const val ISOTIPO_B64 = "P/+AAAAAD8B//8AAAAB/8P//4AAAAP/4///gAAAB//z//+AAAAH//v//4AAAA//+///gAAAD/////+AAAAf/////4AAAB//////gAAAH/////+AAAAf/////4AAAB//////gAAAD//7//+AAAAP//v//4AAAAf/+///gAAAB//z//+AAAAD/+H//wAAAAD/gP/+AAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAB//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/+A//8B//x//8H//4P//v//4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f//3//wf//g//+P/+A//8B//w="
  private const val LEMA = "Tu negocio, inteligente y bajo control."
  // GS v 0 m=0, 8 bytes por fila x 64 filas; ESC J n avanza n puntos (aire arriba y abajo). Chars 0..255 (latin1).
  private val ISOTIPO: String by lazy {
    val sb = StringBuilder(ESC + "J" + 8.toChar() + GS + "v0" + 0.toChar() + 8.toChar() + 0.toChar() + 64.toChar() + 0.toChar())
    for (by in java.util.Base64.getDecoder().decode(ISOTIPO_B64)) sb.append((by.toInt() and 0xff).toChar())
    sb.append(ESC + "J" + 6.toChar()).toString()
  }
  // Con imagen o sin ella (se fija en render() para el hilo que imprime).
  private val conImagen = ThreadLocal.withInitial { true }
  private const val SEP = " - "
  fun pieTexto(app: String, ancho: Int = 48): String {
    val a = app.trim().uppercase()
    val quien = if (a == "KOMO" || a == "KIPU" || a == "KUTI") "Hecho con " + a + SEP + "levodev.app" else "LevoDev" + SEP + "levodev.app"
    val lema = if (ancho >= 40) LEMA + NL else "Tu negocio, inteligente" + NL + "y bajo control." + NL
    return quien + NL + lema
  }
  fun pieConImagen(app: String, ancho: Int, imagen: Boolean): String = (if (imagen) ISOTIPO else "") + pieTexto(app, ancho)
  private fun pie(app: String, ancho: Int) = FONT0 + pieConImagen(app, ancho, conImagen.get() == true) + CORTE

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
    val r = rpc(c, c.prefijo + "_agente_config", JSONObject().put("device", c.device).put("version", "apk/" + VERSION))
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

  // [MM3-01 · 4-nov] Comanda de cocina: jerarquia para leerla de pie y de lejos, y SIN marca. Titulo chico,
  // la MESA enorme (GS ! 0x22), mozo y hora en negrita, cada item en doble alto y negrita (el nombre largo
  // baja con sangria) y su nota en negrita debajo. Mismo papel que komo-print, el .exe de LevoPrint y el de KOMO.
  private val ALTO = GS + "!" + 1.toChar()
  private fun renderComanda(pl: JSONObject, ancho: Int, app: String): String {
    val b = StringBuilder(INIT + CENTRO)
    if (pl.optBoolean("correccion")) b.append(NEG_ON + GRANDE + "*** CORRECCION ***" + NL + NORMAL + NEG_OFF)
    else b.append(NEG_ON + "COMANDA" + NL + NEG_OFF)
    val mesa = "MESA " + pl.optString("mesa").ifBlank { "-" }
    b.append(NEG_ON + (if (mesa.length * 3 <= ancho) ENORME else if (mesa.length * 2 <= ancho) GRANDE else "") + mesa + NL + NORMAL + NEG_OFF)
    b.append(IZQ + linea(ancho, "="))
    b.append(NEG_ON + fila("Mozo: " + pl.optString("mozo").ifBlank { "-" }, pl.optString("hora", ""), ancho) + NEG_OFF)
    if (pl.optInt("ronda") > 0) b.append(fila("Ronda " + pl.optInt("ronda"), "", ancho))
    b.append(linea(ancho, "="))
    if (pl.optString("mensaje").isNotBlank())
      b.append(NEG_ON + GRANDE + pl.optString("mensaje") + NL + NORMAL + NEG_OFF + linea(ancho))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      val cab = cant(it.optDouble("cantidad", 1.0)) + " x "
      envolver(it.optString("nombre"), maxOf(8, ancho - cab.length)).ifEmpty { listOf("(sin nombre)") }.forEachIndexed { j, l ->
        b.append(NEG_ON + ALTO + (if (j == 0) cab else " ".repeat(cab.length)) + l + NL + NORMAL + NEG_OFF)
      }
      val nota = it.optString("nota")
      if (nota.isNotBlank()) for (l in envolver(nota, ancho - 6)) b.append(NEG_ON + "   >> " + l + NEG_OFF + NL)
    }
    val nota = pl.optString("nota")
    if (nota.isNotBlank()) { b.append(linea(ancho)); for (l in envolver("NOTA: " + nota, ancho)) b.append(NEG_ON + l + NEG_OFF + NL) }
    // [MM4-09 · P6 · 3-nov] La comanda no lleva pie: al cliente nunca le llega y eran lineas de
    // rollo por ronda que se botan. Solo el corte (el parametro app queda por simetria con los demas).
    b.append(linea(ancho, "=") + CORTE)
    return b.toString()
  }

  // [MM4-06 · 3-nov] Papel corto al vincular: el cajero ve en papel que funciona en su primer
  // turno. "nombre" es el del canje ("<estacion> · <negocio>"): cada parte va en su linea (sin el
  // punto medio, que depende de la pagina de codigos). Solo local: no pasa por la cola del servidor.
  fun renderVinculado(nombre: String, hora: String, ancho: Int, app: String, imagen: Boolean = true): String {
    conImagen.set(imagen)
    val b = StringBuilder(INIT + CENTRO + "LevoPrint" + NL + NEG_ON + GRANDE + "VINCULADO" + NL + NORMAL + NEG_OFF)
    b.append(linea(ancho, "="))
    for (parte in nombre.split(" · ").map { it.trim() }.filter { it.isNotBlank() }) b.append(parte.take(ancho) + NL)
    if (hora.isNotBlank()) b.append(hora + NL)
    b.append(linea(ancho, "=") + "Si lees esto, la impresora" + NL + "ya funciona." + NL + pie(app, ancho))
    return b.toString()
  }

  private fun renderPrecuenta(pl: JSONObject, ancho: Int, app: String): String {
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
    b.append(CENTRO + "[QR] " + pl.optString("qr") + NL + "NO ES COMPROBANTE DE PAGO" + NL + pie(app, ancho))
    return b.toString()
  }

  private fun renderTicket(pl: JSONObject, ancho: Int, app: String): String {
    // [kuti] KUTI manda "refTipo" (KOMO/KIPU no): su nota de venta va aparte y
    // lo de KOMO/KIPU sale byte a byte igual que antes (AgentRenderTest).
    if (pl.has("refTipo")) return renderTicketKuti(pl, ancho, app)
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
    b.append(linea(ancho, "=") + CENTRO + "NO ES COMPROBANTE DE PAGO" + NL + pie(app, ancho))
    return b.toString()
  }

  // Texto de un campo que puede venir null en el JSON (optString daria "null").
  private fun txt(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.optString(k)

  // [kuti] Nota de venta de KUTI (misma forma que la rama retail del .exe):
  // negocio, local, VENTA o ALQUILER DE SILLA, nota, quien atendio, cliente
  // (en alquiler, el profesional), servicios con su profesional en una segunda
  // linea, TOTAL, pagos y propinas APARTE (no suman al total).
  // [QA M2 · 4-nov] El nombre del negocio va en doble ancho (cabe la mitad de las columnas): se parte por palabras en varios
  // renglones dobles; una palabra que sola no cabe baja a tamano normal en negrita (partida al ancho si hace falta). Nunca se pierde un caracter.
  private fun negocioGrande(nombre: String, ancho: Int): String {
    val mitad = ancho / 2
    val out = StringBuilder(); var l = ""
    fun sale(s: String) { out.append(NEG_ON + (if (s.length <= mitad) GRANDE else "") + s + NL + NORMAL + NEG_OFF) }
    for (w in nombre.uppercase().split(Regex("\\s+")).filter { it.isNotEmpty() }) {
      if (w.length > mitad) { if (l.isNotEmpty()) { sale(l); l = "" }; w.chunked(ancho).forEach { sale(it) }; continue }
      if (l.isNotEmpty() && l.length + 1 + w.length <= mitad) l += " " + w else { if (l.isNotEmpty()) sale(l); l = w }
    }
    if (l.isNotEmpty()) sale(l)
    return out.toString()
  }
  private fun renderTicketKuti(pl: JSONObject, ancho: Int, app: String): String {
    val b = StringBuilder(INIT + CENTRO)
    if (txt(pl, "negocio").isNotBlank()) b.append(negocioGrande(txt(pl, "negocio"), ancho))
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
    b.append(linea(ancho, "=") + CENTRO + "NO ES COMPROBANTE DE PAGO" + NL + pie(app, ancho))
    return b.toString()
  }

  // [kuti] Corte de caja: las lineas {izq, der, sep, negrita} ya vienen formateadas
  // desde la base. Sin "lineas" (KOMO/KIPU) sigue el render generico de siempre.
  private fun renderCierre(pl: JSONObject, ancho: Int, app: String): String {
    val ls = pl.optJSONArray("lineas") ?: return renderGenerico("CIERRE", pl, ancho, app)
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
    b.append(linea(ancho, "=") + CENTRO + pie(app, ancho))
    return b.toString()
  }

  private fun renderCpe(pl: JSONObject, ancho: Int, app: String): String {
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
    b.append("Representacion impresa del" + NL + "comprobante electronico." + NL + "Consulte en sunat.gob.pe" + NL + pie(app, ancho))
    return b.toString()
  }

  private fun renderCartaQr(pl: JSONObject, ancho: Int, app: String): String {
    val b = StringBuilder(INIT + CENTRO + NEG_ON + GRANDE + pl.optString("titulo") + NL + NORMAL + NEG_OFF)
    b.append(FONT0 + (pl.optString("sub").ifBlank { "Escanea nuestra carta" }) + NL + NL)
    if (pl.optString("url").isNotBlank()) b.append(qr(pl.optString("url"), 8) + NL)
    b.append(FONT0 + pl.optString("url") + NL + pie(app, ancho))
    return b.toString()
  }

  // [O-23 · 04-nov] Ticket del cliente SIN CITA de KUTI (tipo TURNO). Mismo papel que kuti-print
  // (render.ts) y que el agente .exe: negocio, local, "TURNO SIN CITA", el numero de la cola
  // (definitivo) o el provisional del equipo (sin red) en triple alto, nombre, con quien, hora y
  // las notas de la hoja de KUTI en ASCII PURO (la pagina de codigos de la termica varia), partidas
  // por palabra al ancho. Payload: negocio, local, definitivo, numero, provisional, nombre, con,
  // fecha, delante (n o null).
  fun envolver(texto: String, ancho: Int): List<String> {
    val out = ArrayList<String>()
    var l = ""
    for (palabra in texto.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
      var w = palabra
      while (w.length > ancho) {
        if (l.isNotEmpty()) { out.add(l); l = "" }
        out.add(w.substring(0, ancho)); w = w.substring(ancho)
      }
      if (w.isEmpty()) continue
      l = if (l.isEmpty()) w else if (l.length + 1 + w.length <= ancho) "$l $w" else { out.add(l); w }
    }
    if (l.isNotEmpty()) out.add(l)
    return out
  }
  private fun numeroTurno(pl: JSONObject, ancho: Int): String {
    val v = if (pl.optBoolean("definitivo")) txt(pl, "numero") else txt(pl, "provisional").ifBlank { txt(pl, "numero") }
    return v.replace(Regex("[^\\x21-\\x7e]"), "").take(maxOf(1, ancho / 3))
  }
  fun notasTurno(pl: JSONObject, ancho: Int): List<String> {
    val n = ArrayList<String>()
    if (pl.optBoolean("definitivo")) {
      // NaN.toInt() da 0 en Kotlin: un "delante" que no es numero no debe decir "Es el siguiente".
      val dd = if (!pl.has("delante") || pl.isNull("delante") || txt(pl, "delante").isBlank()) -1.0 else pl.optDouble("delante", -1.0)
      val d = if (dd.isNaN()) -1 else dd.toInt()
      when {
        d == 0 -> n.add("Es el siguiente en la cola.")
        d == 1 -> n.add("Hay 1 persona delante.")
        d > 1 -> n.add("Hay " + d + " personas delante.")
      }
      n.add("Mira la pantalla de la sala: ahi sale tu numero cuando te toque.")
    } else {
      n.add("Numero provisional: se tomo sin internet.")
      n.add("Cuando vuelva la red recibes tu numero de la cola. En la pantalla de la sala lo veras junto a este, por ejemplo:")
      n.add("15 - " + numeroTurno(pl, ancho) + " (el 15 es un ejemplo)")
      n.add("No pierdes tu lugar: la cola va por la hora en que llegaste.")
    }
    return n
  }
  private fun renderTurno(pl: JSONObject, ancho: Int, app: String): String {
    val b = StringBuilder(INIT + CENTRO)
    val neg = txt(pl, "negocio"); val loc = txt(pl, "local")
    // [QA M2] el negocio va en doble ancho, partido en varios renglones (nunca se corta)
    if (neg.isNotBlank()) b.append(negocioGrande(neg, ancho))
    if (loc.isNotBlank() && loc != neg) b.append(loc + NL)
    b.append(NEG_ON + "TURNO SIN CITA" + NL + NEG_OFF + linea(ancho, "="))
    b.append((if (pl.optBoolean("definitivo")) "Tu numero" else "Tu numero provisional") + NL)
    b.append(NEG_ON + ENORME + numeroTurno(pl, ancho) + NL + NORMAL + NEG_OFF)
    if (txt(pl, "nombre").isNotBlank()) b.append(txt(pl, "nombre").take(ancho) + NL)
    if (txt(pl, "con").isNotBlank()) b.append(("Con " + txt(pl, "con")).take(ancho) + NL)
    val hora = txt(pl, "fecha").ifBlank { txt(pl, "hora") }
    if (hora.isNotBlank()) b.append(hora + NL)
    b.append(IZQ + linea(ancho))
    for (nota in notasTurno(pl, ancho)) for (l in envolver(nota, ancho)) b.append(l + NL)
    b.append(linea(ancho, "=") + CENTRO + pie(app, ancho))
    return b.toString()
  }

  private fun renderGenerico(tipo: String, pl: JSONObject, ancho: Int, app: String): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + tipo + NL + NORMAL + IZQ + linea(ancho, "="))
    val its = items(pl)
    for (i in 0 until its.length()) {
      val it = its.getJSONObject(i)
      b.append(cant(it.optDouble("cantidad", 1.0)) + " x " + it.optString("nombre") + NL)
    }
    b.append(linea(ancho, "=") + CENTRO + pie(app, ancho))
    return b.toString()
  }

  // [MM3-01] appCfg = prefijo de la configuracion del local (komo/kipu/kuti). Si viene vacio
  // (pruebas, equipos viejos) se usa el "app" del payload; si tampoco hay, el pie generico.
  fun render(job: JSONObject, ancho: Int, appCfg: String = "", imagen: Boolean = true): String {
    val tipo = job.optString("tipo")
    val pl = job.optJSONObject("payload") ?: JSONObject()
    // [MM3-01 · MM3-P1] sin imagen si la impresora no la soporta (interruptor del equipo) o el payload lo pide
    conImagen.set(imagen && !pl.optBoolean("sinImagen"))
    val app = appCfg.ifBlank { pl.optString("app") }
    val t = when (tipo) {
      "PRUEBA" -> INIT + CENTRO + "PRUEBA LEVOPRINT OK" + NL + pie(app, ancho) // la prueba lleva el pie: se ve si la impresora imprime el logo
      "COMANDA" -> renderComanda(pl, ancho, app)
      "PRECUENTA" -> renderPrecuenta(pl, ancho, app)
      "TICKET" -> renderTicket(pl, ancho, app)
      "CPE" -> renderCpe(pl, ancho, app)
      "CARTA_QR" -> renderCartaQr(pl, ancho, app)
      "TURNO" -> renderTurno(pl, ancho, app)
      "CIERRE" -> renderCierre(pl, ancho, app)
      else -> renderGenerico(tipo.ifBlank { "COMPROBANTE" }, pl, ancho, app)
    }
    // [kuti] Toda reimpresion de KUTI trae "copia": sello arriba. KOMO/KIPU no lo mandan.
    if (!pl.optBoolean("copia") || !t.startsWith(INIT)) return t
    return INIT + CENTRO + NEG_ON + GRANDE + "*** COPIA ***" + NL + NORMAL + NEG_OFF + IZQ + t.substring(INIT.length)
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
