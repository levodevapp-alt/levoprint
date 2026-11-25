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
class RpcError(val fn: String, val http: Int, val pgMensaje: String, cuerpo: String, val pgCodigo: String = "") :
  RuntimeException(fn + " HTTP " + http + ": " + cuerpo.take(180)) {
  val agenteInvalido: Boolean get() = pgMensaje == "AGENTE_INVALIDO"
  // [LP-F3] Backend sin el modulo levoprint_transporte: PostgREST responde 404 con code PGRST202
  // ("Could not find the function"). El APK sigue como la 1.6 (solo IP / Bluetooth general) por 30 min.
  val ausente: Boolean get() = pgCodigo == "PGRST202" || http == 404 || pgMensaje.contains("Could not find the function", ignoreCase = true)
}

object Agent {
  // [O-23 · QA MEDIO-2] Versión de este APK (= versionName de app/build.gradle.kts; AgentRenderTest lo comprueba).
  // Va en <prefijo>_agente_config (p.version = "apk/1.7.0"): KUTI (kuti_turno_print) solo manda el papel TURNO a un
  // local cuyos agentes vivos lo saben dibujar. KOMO/KIPU la ignoran. [LP-F3] Tambien va en <prefijo>_agente_impresoras:
  // la consola avisa «Actualiza LevoPrint» a los equipos con menos de apk/1.7.0.
  // [RCA · 25-nov] 1.8.0: los papeles de la cola salen del render comun (RenderComun.kt); el CPE trae «SON: … SOLES».
  const val VERSION = "1.8.0"
  // [Re-QA LP-F3] = versionCode de app/build.gradle.kts (AgentRenderTest lo comprueba): el aviso de actualizacion lo compara con LevoPrint.json.
  const val VERSION_CODE = 15
  // ESC/POS con codigos de caracter (sin bytes de control crudos en el
  // fuente). Se construye TODO como String de chars 0..255 y se envia en
  // latin1 (ISO-8859-1), igual que el agente .exe (Buffer 'binary').
  private val ESC = 27.toChar().toString()
  private val GS = 29.toChar().toString()
  private val NL = 10.toChar().toString()
  private val INIT = ESC + "@"
  private val CENTRO = ESC + "a" + 1.toChar()
  private val NEG_ON = ESC + "E" + 1.toChar()
  private val NEG_OFF = ESC + "E" + 0.toChar()
  private val GRANDE = GS + "!" + 17.toChar()
  private val NORMAL = GS + "!" + 0.toChar()
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
    val lema = if (ancho >= 40) LEMA + NL else if (ancho >= 24) "Tu negocio, inteligente" + NL + "y bajo control." + NL
      else "Tu negocio," + NL + "inteligente y" + NL + "bajo control." + NL
    // [Re-QA B4] bajo 28 columnas "Hecho con <APP> - levodev.app" no cabe: la direccion baja a su renglon.
    return (if (quien.length > ancho) quien.replace(SEP, NL) else quien) + NL + lema
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
      val j = try { JSONObject(txt) } catch (_: Exception) { JSONObject() }
      throw RpcError(fn, code, j.optString("message").trim(), txt, j.optString("code").trim())
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

  // ---- ESC/POS ----
  // [RCA · 25-nov] Los papeles de la cola (COMANDA, PRECUENTA, TICKET, CPE, CIERRE, CARTA_QR, TURNO, PRUEBA) los dibuja
  // RenderComun.kt = port de levodev-modules core/print/render.mjs, el mismo de las Edges <prefijo>-print y del .exe:
  // el CPE trae «SON: … SOLES», ICBPER, la leyenda de montosOcultos, COPIA de KUTI y el aviso de turno de KIPU.
  // Aqui solo queda el papel de VINCULADO (local, no pasa por la cola).
  private fun linea(ancho: Int, ch: String = "-") = ch.repeat(ancho) + NL

  // [MM4-06 · 3-nov] Papel corto al vincular: el cajero ve en papel que funciona en su primer
  // turno. "nombre" es el del canje ("<estacion> · <negocio>"): cada parte va en su linea (sin el
  // punto medio, que depende de la pagina de codigos). Solo local: no pasa por la cola del servidor.
  fun renderVinculado(nombre: String, hora: String, anchoIn: Int, app: String, imagen: Boolean = true): String {
    val ancho = anchoValido(anchoIn)
    conImagen.set(imagen)
    val b = StringBuilder(INIT + CENTRO + "LevoPrint" + NL + NEG_ON + GRANDE + "VINCULADO" + NL + NORMAL + NEG_OFF)
    b.append(linea(ancho, "="))
    for (parte in nombre.split(" · ").map { it.trim() }.filter { it.isNotBlank() }) b.append(parte.take(ancho) + NL)
    if (hora.isNotBlank()) b.append(hora + NL)
    b.append(linea(ancho, "=") + "Si lees esto, la impresora" + NL + "ya funciona." + NL + pie(app, ancho))
    return b.toString()
  }

  // [Re-QA BAJO-1 · RCA 25-nov] el ancho valido de la configuracion es 24-100 (como la ventana del .exe); fuera de eso
  // se acota, nunca <= 0. Antes el minimo era 20, pero el render comun (el de la Edge) imprime a 24 como minimo: quien
  // tenia 20-23 pasa a 24 y la app lo dice (avisoAncho).
  const val ANCHO_MIN = 24
  fun anchoValido(n: Int): Int = n.coerceIn(ANCHO_MIN, 100)
  // Texto para quien tenia un ancho de 20-23 columnas (o lo escribe): null si no hace falta avisar.
  fun avisoAncho(pedido: Int): String? =
    if (pedido in 1 until ANCHO_MIN) "El ancho minimo de papel ahora es $ANCHO_MIN columnas: tenias $pedido y se usa $ANCHO_MIN (igual que el papel del servidor)." else null

  // [RCA] org.json (JSONObject de Android, que conserva el orden de las claves) → modelo de RenderComun:
  // Map ordenado / List / String / Double / Boolean / null (JSONObject.NULL). Los numeros van como Double, igual que
  // JSON.parse de JS (la Edge recibe el mismo JSON).
  fun desdeOrgJson(x: Any?): Any? = when {
    x == null || x === JSONObject.NULL -> null
    x is JSONObject -> LinkedHashMap<String, Any?>().also { m -> val ks = x.keys(); while (ks.hasNext()) { val k = ks.next(); m[k] = desdeOrgJson(x.opt(k)) } }
    x is JSONArray -> ArrayList<Any?>().also { l -> for (i in 0 until x.length()) l.add(desdeOrgJson(x.opt(i))) }
    x is Number -> x.toDouble()
    x is Boolean || x is String -> x
    else -> x.toString()
  }
  // App del papel (pie «Hecho con <APP>» y familia pos/kuti): la del prefijo del local (komo → KOMO); si viene vacio
  // (pruebas, equipos viejos), la del payload; si tampoco sirve, LEVODEV (familia pos).
  fun appDelRender(appCfg: String, pl: Any?): String {
    val a = appCfg.trim().uppercase()
    if (Regex("^[A-Z]{2,12}$").matches(a)) return a
    val b = Js.str(Js.or(Js.get(pl, "app"), "")).trim().uppercase()
    return if (Regex("^[A-Z]{2,12}$").matches(b)) b else "LEVODEV"
  }

  // [RCA · 25-nov] Papel de la cola = render común (mismo que la Edge <prefijo>-print). imagen = interruptor «Pie con
  // logo» del equipo; payload.sinImagen lo apaga para un papel. Devuelve chars 0..255 (lo de fuera de latin1 ya es «?»).
  fun render(job: JSONObject, anchoIn: Int, appCfg: String = "", imagen: Boolean = true): String {
    val pl = desdeOrgJson(job.opt("payload"))
    val tipo = desdeOrgJson(job.opt("tipo"))
    return RenderComun(appDelRender(appCfg, pl)).render(tipo, pl, anchoIn.toDouble(), imagen)
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
