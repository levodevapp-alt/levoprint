package dev.levo.levoprint

import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

// ============================================================
// LevoPrint APK · RENDER COMÚN (port a Kotlin de levodev-modules core/print/render.mjs)
// ------------------------------------------------------------
// [RCA · 25-nov] El APK dibuja siempre en local (no llama a la Edge <prefijo>-print). Hasta la 1.7.2 tenía su propio
// render y, entre otras cosas, su CPE NO imprimía «SON: … SOLES» (monto en letras de la representación impresa). Este
// archivo es una traducción LÍNEA A LÍNEA de render.mjs con la semántica de JavaScript que importa para los bytes:
// truthy/falsy, String(x) y Number(x) de JS, toFixed (redondeo del valor binario exacto), Math.round, parseInt,
// \s de JS, JSON.stringify(x, null, 1), «?» por cada unidad UTF-16 fuera de latin1. Prueba:
// RenderComunFixturesTest compara los fixtures de las Edges vivas (render_comun/fixtures.json) BYTE A BYTE.
// RENDER_SHA256 = sha256 (LF) del render.mjs con el que se comparó: si render_comun/ORIGEN.json cambia (nueva
// sincronización), la prueba y el --check del agente fallan hasta revisar este port.
// Valores: el payload llega como Map (orden de claves conservado) / List / String / Double / Boolean / null, y la
// clave ausente es Indefinido (undefined de JS). Agent.kt convierte el JSONObject de org.json a este modelo.
// LevoDev
// ============================================================

/** undefined de JS: clave ausente (distinto de null = JSON null). */
object Indefinido { override fun toString() = "undefined" }

/** Semántica de JavaScript que usa el render (solo lo necesario, nada más). */
object Js {
  // \s de JS (WhiteSpace + LineTerminator)
  const val ESPACIOS = "\\t\\n\\u000B\\u000C\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
  private val RE_ESPACIOS = Regex("[$ESPACIOS]+")
  private val RE_BORDES = Regex("^[$ESPACIOS]+|[$ESPACIOS]+$")
  private val RE_DECIMAL = Regex("^[+-]?((\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?)$")
  private val RE_ENTERO = Regex("^[+-]?\\d+")

  fun trim(s: String): String = s.replace(RE_BORDES, "")
  fun partir(s: String): List<String> = s.split(RE_ESPACIOS).filter { it.isNotEmpty() }

  fun get(o: Any?, k: String): Any? = if (o is Map<*, *>) (if (o.containsKey(k)) o[k] else Indefinido) else Indefinido
  fun nulo(v: Any?): Boolean = v == null || v === Indefinido
  fun truthy(v: Any?): Boolean = when (v) {
    null -> false
    is Indefinido -> false
    is Boolean -> v
    is Number -> v.toDouble().let { !(it == 0.0 || it.isNaN()) }
    is String -> v.isNotEmpty()
    else -> true
  }
  fun or(a: Any?, b: Any?): Any? = if (truthy(a)) a else b

  /** String(x) de JS. */
  fun str(v: Any?): String = when (v) {
    null -> "null"
    is Indefinido -> "undefined"
    is String -> v
    is Boolean -> v.toString()
    is Number -> numStr(v.toDouble())
    is List<*> -> v.joinToString(",") { if (nulo(it)) "" else str(it) }
    is Map<*, *> -> "[object Object]"
    else -> v.toString()
  }

  /** Number.prototype.toString() de JS (radix 10). */
  fun numStr(d: Double): String {
    if (d.isNaN()) return "NaN"
    if (d == 0.0) return "0"
    if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
    if (d < 0) return "-" + numStr(-d)
    // Double.toString da los dígitos más cortos que vuelven al mismo double (como JS); luego el formato de JS.
    val bd = BigDecimal(d.toString()).stripTrailingZeros()
    val dig = bd.unscaledValue().toString()
    val k = dig.length
    val n = k - bd.scale() // valor = 0.dig × 10^n
    return when {
      n in k..21 -> dig + "0".repeat(n - k)
      n in 1..21 -> dig.substring(0, n) + "." + dig.substring(n)
      n in -5..0 -> "0." + "0".repeat(-n) + dig
      else -> {
        val e = n - 1
        (if (k == 1) dig else dig[0] + "." + dig.substring(1)) + "e" + (if (e >= 0) "+" else "-") + Math.abs(e)
      }
    }
  }

  /** Number(x) de JS. */
  fun num(v: Any?): Double = when (v) {
    null -> 0.0
    is Indefinido -> Double.NaN
    is Boolean -> if (v) 1.0 else 0.0
    is Number -> v.toDouble()
    is String -> numDeTexto(v)
    is List<*> -> numDeTexto(str(v))
    else -> Double.NaN
  }
  fun numDeTexto(s0: String): Double {
    val s = trim(s0)
    if (s.isEmpty()) return 0.0
    when (s) { "Infinity", "+Infinity" -> return Double.POSITIVE_INFINITY; "-Infinity" -> return Double.NEGATIVE_INFINITY }
    if (s.length > 2 && s[0] == '0') {
      val radix = when (s[1]) { 'x', 'X' -> 16; 'o', 'O' -> 8; 'b', 'B' -> 2; else -> 0 }
      if (radix > 0) return try { BigInteger(s.substring(2), radix).toDouble() } catch (_: NumberFormatException) { Double.NaN }
    }
    if (!RE_DECIMAL.matches(s)) return Double.NaN
    return s.toDouble() // Double.parseDouble redondea al double más cercano, como JS
  }
  /** parseInt(x, 10) de JS. */
  fun parseInt10(s0: String): Double {
    val m = RE_ENTERO.find(trim(s0)) ?: return Double.NaN
    return BigInteger(m.value.removePrefix("+")).toDouble()
  }
  /** Number.prototype.toFixed(f): redondea el valor binario EXACTO (BigDecimal(double)), mitad hacia arriba. */
  fun toFixed(d: Double, f: Int): String {
    if (d.isNaN()) return "NaN"
    if (Math.abs(d) >= 1e21) return numStr(d)
    if (d < 0) return "-" + BigDecimal(-d).setScale(f, RoundingMode.HALF_UP).toPlainString()
    return BigDecimal(d).setScale(f, RoundingMode.HALF_UP).toPlainString()
  }
  /** Math.round de JS (empates hacia +infinito). */
  fun round(x: Double): Double = if (x.isNaN() || x.isInfinite() || Math.abs(x) >= 4503599627370496.0) x else Math.round(x).toDouble()

  /** JSON.stringify(v, null, gap) de JS (null si v no se serializa: undefined). */
  fun stringify(v: Any?, gap: String, ind: String = ""): String? = when (v) {
    null -> "null"
    is Indefinido -> null
    is Boolean -> v.toString()
    is Number -> v.toDouble().let { if (it.isNaN() || it.isInfinite()) "null" else numStr(it) }
    is String -> comillas(v)
    is List<*> -> if (v.isEmpty()) "[]" else {
      val ni = ind + gap
      "[\n" + v.joinToString(",\n") { ni + (stringify(it, gap, ni) ?: "null") } + "\n" + ind + "]"
    }
    is Map<*, *> -> {
      val ni = ind + gap
      val partes = v.entries.mapNotNull { (k, x) -> stringify(x, gap, ni)?.let { ni + comillas(k.toString()) + ": " + it } }
      if (partes.isEmpty()) "{}" else "{\n" + partes.joinToString(",\n") + "\n" + ind + "}"
    }
    else -> comillas(v.toString())
  }
  private fun hex4(c: Int) = "\\u" + String.format(java.util.Locale.ROOT, "%04x", c)
  fun comillas(s: String): String {
    val b = StringBuilder("\"")
    var i = 0
    while (i < s.length) {
      val c = s[i]
      when {
        c == '"' -> b.append("\\\"")
        c == '\\' -> b.append("\\\\")
        c == '\b' -> b.append("\\b")
        c == '\u000C' -> b.append("\\f")
        c == '\n' -> b.append("\\n")
        c == '\r' -> b.append("\\r")
        c == '\t' -> b.append("\\t")
        c.code < 0x20 -> b.append(hex4(c.code))
        c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> { b.append(c).append(s[i + 1]); i++ }
        c.isSurrogate() -> b.append(hex4(c.code)) // sustituto suelto (JSON.stringify bien formado, ES2019)
        else -> b.append(c)
      }
      i++
    }
    return b.append('"').toString()
  }
  /** Buffer.from(s, 'utf8') de Node: un sustituto suelto sale EF BF BD. */
  fun utf8(s: String): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
      val c = s[i]
      var cp = c.code
      if (c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate()) { cp = Character.toCodePoint(c, s[i + 1]); i++ }
      else if (c.isSurrogate()) cp = 0xFFFD
      when {
        cp < 0x80 -> out.write(cp)
        cp < 0x800 -> { out.write(0xC0 or (cp shr 6)); out.write(0x80 or (cp and 0x3F)) }
        cp < 0x10000 -> { out.write(0xE0 or (cp shr 12)); out.write(0x80 or ((cp shr 6) and 0x3F)); out.write(0x80 or (cp and 0x3F)) }
        else -> { out.write(0xF0 or (cp shr 18)); out.write(0x80 or ((cp shr 12) and 0x3F)); out.write(0x80 or ((cp shr 6) and 0x3F)); out.write(0x80 or (cp and 0x3F)) }
      }
      i++
    }
    return out.toByteArray()
  }
  /** Lo que no cabe en latin1 sale «?» por cada unidad UTF-16 (replace(/[^\x00-\xff]/g, '?') de JS). */
  fun latin1(s: String): String {
    if (s.none { it.code > 0xFF }) return s
    val b = StringBuilder(s.length)
    for (c in s) b.append(if (c.code > 0xFF) '?' else c)
    return b.toString()
  }
}

/** Lector JSON que conserva el orden de las claves (JSON.parse de JS: números como Double). */
object JsonOrdenado {
  fun parse(texto: String): Any? {
    val p = Lector(texto)
    p.blancos()
    val v = p.valor()
    p.blancos()
    if (p.i != texto.length) throw IllegalArgumentException("JSON: sobra texto en " + p.i)
    return v
  }
  private class Lector(val s: String) {
    var i = 0
    fun blancos() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }
    fun valor(): Any? {
      blancos()
      if (i >= s.length) throw IllegalArgumentException("JSON: fin inesperado")
      return when (s[i]) {
        '{' -> objeto()
        '[' -> lista()
        '"' -> texto()
        't' -> literal("true", true)
        'f' -> literal("false", false)
        'n' -> literal("null", null)
        else -> numero()
      }
    }
    fun literal(l: String, v: Any?): Any? {
      if (!s.startsWith(l, i)) throw IllegalArgumentException("JSON: literal inválido en $i")
      i += l.length
      return v
    }
    fun objeto(): Map<String, Any?> {
      val m = LinkedHashMap<String, Any?>()
      i++; blancos()
      if (s[i] == '}') { i++; return m }
      while (true) {
        blancos()
        val k = texto()
        blancos()
        if (s[i] != ':') throw IllegalArgumentException("JSON: falta ':' en $i")
        i++
        m[k] = valor()
        blancos()
        if (s[i] == ',') { i++; continue }
        if (s[i] == '}') { i++; return m }
        throw IllegalArgumentException("JSON: objeto mal cerrado en $i")
      }
    }
    fun lista(): List<Any?> {
      val l = ArrayList<Any?>()
      i++; blancos()
      if (s[i] == ']') { i++; return l }
      while (true) {
        l.add(valor())
        blancos()
        if (s[i] == ',') { i++; continue }
        if (s[i] == ']') { i++; return l }
        throw IllegalArgumentException("JSON: lista mal cerrada en $i")
      }
    }
    fun texto(): String {
      if (s[i] != '"') throw IllegalArgumentException("JSON: se esperaba texto en $i")
      i++
      val b = StringBuilder()
      while (true) {
        val c = s[i++]
        when (c) {
          '"' -> return b.toString()
          '\\' -> {
            when (val e = s[i++]) {
              '"' -> b.append('"'); '\\' -> b.append('\\'); '/' -> b.append('/')
              'b' -> b.append('\b'); 'f' -> b.append('\u000C'); 'n' -> b.append('\n'); 'r' -> b.append('\r'); 't' -> b.append('\t')
              'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
              else -> throw IllegalArgumentException("JSON: escape inválido \\$e")
            }
          }
          else -> b.append(c)
        }
      }
    }
    fun numero(): Double {
      val ini = i
      while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
      return s.substring(ini, i).toDouble()
    }
  }
}

/**
 * Render ESC/POS común (familias «pos» y «kuti»), igual BYTE A BYTE que la Edge <prefijo>-print.
 * Uso: RenderComun("KOMO").render(tipo, payload, ancho, imagen) → String de chars 0..255 (latin1, «?» fuera).
 * Una instancia por papel (ancho e imagen son estado del papel en curso, como en render.mjs).
 */
class RenderComun(app: String) {
  companion object {
    /** sha256 (LF) de render_comun/render.mjs con el que este port se comparó (= render_comun/ORIGEN.json). */
    const val RENDER_SHA256 = "f061ee1942aa21d1e5f6718d21d36eb3122c695def0f766cf2ffa1e33cb23374"
    const val MAX_FILAS = 500
    private val APP_VALIDA = Regex("^[A-Z]{2,12}$")
    private const val ESC = "\u001b"
    private const val GS = "\u001d"
    private const val INIT = ESC + "@"
    private const val CENTRO = ESC + "a\u0001"
    private const val IZQ = ESC + "a\u0000"
    private const val NEG_ON = ESC + "E\u0001"
    private const val NEG_OFF = ESC + "E\u0000"
    private const val GRANDE = GS + "!\u0011"
    private const val NORMAL = GS + "!\u0000"
    private const val ENORME = GS + "!\"" // GS ! 0x22: triple de ancho y alto
    private const val ALTO = GS + "!\u0001"
    private const val FONT0 = ESC + "!\u0000"
    private const val CORTE = "\n\n\n" + GS + "V\u0000"
    private const val LEMA = "Tu negocio, inteligente y bajo control."
    private const val ISOTIPO_B64 = "P/+AAAAAD8B//8AAAAB/8P//4AAAAP/4///gAAAB//z//+AAAAH//v//4AAAA//+///gAAAD/////+AAAAf/////4AAAB//////gAAAH/////+AAAAf/////4AAAB//////gAAAD//7//+AAAAP//v//4AAAAf/+///gAAAB//z//+AAAAD/+H//wAAAAD/gP/+AAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAD//+AAAAAAAP//4AAAAAAA///gAAAAAAB//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/+A//8B//x//8H//4P//v//4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f/////4f//h//////h//+H/////+H//4f//3//wf//g//+P/+A//8B//w="
    private val ISOTIPO: String by lazy {
      val b = StringBuilder(ESC + "J\u0008" + GS + "v0\u0000\u0008\u0000@\u0000")
      for (x in java.util.Base64.getDecoder().decode(ISOTIPO_B64)) b.append((x.toInt() and 0xff).toChar())
      b.append(ESC + "J\u0006").toString()
    }
    private val U_ = listOf("", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE")
    private val D_ = listOf("", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA")
    private val C_ = listOf("", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS")
    // arr[i] de JS: fuera de rango o no entero = undefined (se concatena como «undefined», igual que la Edge)
    private fun idx(a: List<String>, d: Double): String = if (d % 1.0 == 0.0 && d >= 0 && d < a.size) a[d.toInt()] else "undefined"
    private fun centenas(n: Double): String {
      if (n == 100.0) return "CIEN"
      var t = ""
      val c = Math.floor(n / 100); val r = n % 100
      if (Js.truthy(c)) t += idx(C_, c) + " "
      if (r <= 20) t += idx(U_, r) else {
        val d = Math.floor(r / 10); val u = r % 10
        t += if (d == 2.0) (if (Js.truthy(u)) "VEINTI" + idx(U_, u) else "VEINTE") else idx(D_, d) + (if (Js.truthy(u)) " Y " + idx(U_, u) else "")
      }
      return Js.trim(t)
    }
    private fun seccion(n0: Double): String {
      var n = n0
      var t = ""
      val mill = Math.floor(n / 1000000); n %= 1000000
      if (Js.truthy(mill)) t += if (mill == 1.0) "UN MILLON " else centenas(mill) + " MILLONES "
      val mil = Math.floor(n / 1000); n %= 1000
      if (Js.truthy(mil)) t += if (mil == 1.0) "MIL " else centenas(mil) + " MIL "
      if (Js.truthy(n)) t += centenas(n)
      return Js.trim(t).ifEmpty { "CERO" }
    }
    private fun denomCpe(tipo: Any?): String {
      val t = Js.str(Js.or(tipo, "")).uppercase()
      if (t.contains("FACTURA")) return "FACTURA ELECTRONICA"
      if (t.contains("BOLETA")) return "BOLETA DE VENTA ELECTRONICA"
      if (t.contains("CREDITO")) return "NOTA DE CREDITO ELECTRONICA"
      if (t.contains("DEBITO")) return "NOTA DE DEBITO ELECTRONICA"
      return t.ifEmpty { "COMPROBANTE" }
    }
    private fun fmtCant(v: Any?): String { val n = Js.num(v); return if (n % 1.0 == 0.0) Js.numStr(n) else Js.toFixed(n, 3) }
    private fun mayus(s: String): String = Js.latin1(s.uppercase())
    private fun qrEscPos(texto: Any?, tam: Int = 5): String {
      val data = Js.utf8(Js.str(Js.or(texto, "")))
      val len = data.size + 3
      val b = StringBuilder()
      b.append(GS + "(k\u0004\u00001A2\u0000")
      b.append(GS + "(k\u0003\u00001C").append(tam.toChar())
      b.append(GS + "(k\u0003\u00001E1")
      b.append(GS + "(k").append((len and 0xff).toChar()).append(((len shr 8) and 0xff).toChar()).append("1P0")
      for (x in data) b.append((x.toInt() and 0xff).toChar())
      b.append(GS + "(k\u0003\u00001Q0")
      return b.toString()
    }
    /** envolver() de render.mjs: parte por palabras (\s de JS) al ancho; la palabra que no cabe se corta. */
    fun envolver(texto: Any?, anchoIn: Int): List<String> {
      val ancho = maxOf(1, anchoIn)
      val out = ArrayList<String>()
      var l = ""
      for (palabra in Js.partir(Js.str(if (Js.nulo(texto)) "" else texto))) {
        var w = palabra
        while (w.length > ancho) { if (l.isNotEmpty()) { out.add(l); l = "" }; out.add(w.substring(0, ancho)); w = w.substring(ancho) }
        if (w.isEmpty()) continue
        l = if (l.isEmpty()) w else if (l.length + 1 + w.length <= ancho) "$l $w" else { out.add(l); w }
      }
      if (l.isNotEmpty()) out.add(l)
      return out
    }
  }

  private val APP: String = app.uppercase().also { if (!APP_VALIDA.matches(it)) throw IllegalArgumentException("crearRender: app inválida") }
  private val KUTI = APP == "KUTI"
  private var ANCHO = 48
  private var IMAGEN = true

  private fun g(o: Any?, k: String) = Js.get(o, k)
  private fun t(o: Any?, k: String) = Js.truthy(Js.get(o, k))
  private fun linea(c: String = "-") = c.repeat(ANCHO) + "\n"
  private fun fila(izq: Any?, der: Any?): String {
    val d = if (KUTI) Js.str(if (Js.nulo(der)) "" else der) else Js.str(der)
    var i = if (KUTI) Js.str(if (Js.nulo(izq)) "" else izq) else Js.str(izq)
    if (KUTI && i.length + d.length + 1 > ANCHO) i = i.take(maxOf(0, ANCHO - d.length - 1))
    val esp = maxOf(1, ANCHO - i.length - d.length)
    return i + " ".repeat(esp) + d + "\n"
  }
  private fun money(n: Any?): String = "S/ " + Js.toFixed(if (KUTI) Js.num(Js.or(n, 0.0)) else Js.num(n), 2)
  private fun totalOk(x: Any?): Boolean =
    (x is Number && x.toDouble().let { !it.isNaN() && !it.isInfinite() }) || (x is String && Js.trim(x) != "" && Js.num(x).let { !it.isNaN() && !it.isInfinite() })
  private fun montoTotal(x: Any?) = if (totalOk(x)) money(x) else "--"
  private fun listaPos(x: Any?): List<Any?> = when {
    !Js.truthy(x) -> emptyList()
    x is List<*> -> x
    x is String -> x.map { it.toString() }
    else -> emptyList()
  }
  private fun lista(x: Any?): List<Any?> = if (KUTI) (if (x is List<*>) x.take(MAX_FILAS) else emptyList()) else listaPos(x)
  private fun pagosDe(pl: Any?): List<Any?> = if (t(pl, "montosOcultos")) emptyList() else lista(g(pl, "pagos"))
  private fun numeroALetras(v: Any?): String {
    val x = Js.num(Js.or(v, 0.0))
    if (KUTI) {
      val cent = Js.round(x * 100)
      return seccion(Math.floor(cent / 100)) + " CON " + Js.numStr(cent % 100).padStart(2, '0') + "/100 SOLES"
    }
    val e = Math.floor(x); val cent = Js.round((x - e) * 100)
    return seccion(e) + " CON " + Js.numStr(cent).padStart(2, '0') + "/100 SOLES"
  }
  private fun pieMarca(ancho: Int, imagen: Boolean): String {
    val lema = if (ancho >= 40) LEMA + "\n" else "Tu negocio, inteligente\ny bajo control.\n"
    val quien = "Hecho con $APP - levodev.app"
    return (if (imagen) ISOTIPO else "") + (if (quien.length > ancho) quien.replaceFirst(" - ", "\n") else quien) + "\n" + lema
  }
  private fun firma(pl: Any?) = CENTRO + FONT0 + pieMarca(ANCHO, IMAGEN && !(Js.truthy(pl) && t(pl, "sinImagen")))
  private fun negocioGrande(nombre: Any?): String {
    val mitad = ANCHO / 2
    val out = StringBuilder(); var l = ""
    fun sale(s: String) { out.append(NEG_ON + (if (s.length <= mitad) GRANDE else "") + s + "\n" + NORMAL + NEG_OFF) }
    for (w in Js.partir(mayus(Js.str(if (Js.nulo(nombre)) "" else nombre)))) {
      if (w.length > mitad) { if (l.isNotEmpty()) { sale(l); l = "" }; w.chunked(maxOf(1, ANCHO)).forEach { sale(it) }; continue }
      if (l.isNotEmpty() && l.length + 1 + w.length <= mitad) l += " $w" else { if (l.isNotEmpty()) sale(l); l = w }
    }
    if (l.isNotEmpty()) sale(l)
    return out.toString()
  }

  // ---- COMANDA (cocina/estación, sin marca) ----
  private fun renderComanda(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO)
    b.append(if (t(pl, "correccion")) NEG_ON + GRANDE + "*** CORRECCION ***\n" + NORMAL + NEG_OFF else NEG_ON + "COMANDA\n" + NEG_OFF)
    val mesa = "MESA " + Js.str(Js.or(g(pl, "mesa"), "-"))
    b.append(NEG_ON + (if (mesa.length * 3 <= ANCHO) ENORME else if (mesa.length * 2 <= ANCHO) GRANDE else "") + mesa + "\n" + NORMAL + NEG_OFF)
    b.append(IZQ + linea("="))
    b.append(NEG_ON + fila("Mozo: " + Js.str(Js.or(g(pl, "mozo"), "-")), Js.or(g(pl, "hora"), "")) + NEG_OFF)
    if (t(pl, "ronda")) b.append(fila("Ronda " + Js.str(g(pl, "ronda")), ""))
    b.append(linea("="))
    if (t(pl, "mensaje")) b.append(NEG_ON + GRANDE + Js.str(g(pl, "mensaje")) + "\n" + NORMAL + NEG_OFF + linea())
    for (it in lista(g(pl, "items"))) {
      val cab = fmtCant(g(it, "cantidad")) + " x "
      val ls = envolver(g(it, "nombre"), maxOf(8, ANCHO - cab.length))
      ls.ifEmpty { listOf("(sin nombre)") }.forEachIndexed { i, l ->
        b.append(NEG_ON + ALTO + (if (i == 0) cab else " ".repeat(cab.length)) + l + "\n" + NORMAL + NEG_OFF)
      }
      if (t(it, "nota")) for (l in envolver(g(it, "nota"), ANCHO - 6)) b.append(NEG_ON + "   >> " + l + NEG_OFF + "\n")
    }
    if (t(pl, "nota")) { b.append(linea()); for (l in envolver("NOTA: " + Js.str(g(pl, "nota")), ANCHO)) b.append(NEG_ON + l + NEG_OFF + "\n") }
    b.append(linea("=") + CORTE)
    return b.toString()
  }
  private fun renderPrecuenta(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO + GRANDE + "PRECUENTA\n" + NORMAL)
    b.append("MESA " + Js.str(g(pl, "mesa")) + "\n")
    val cuenta = g(pl, "cuenta")
    if (Js.truthy(cuenta) && t(cuenta, "de")) b.append(NEG_ON + "CUENTA " + Js.str(g(cuenta, "n")) + " de " + Js.str(g(cuenta, "de")) + "\n" + NEG_OFF)
    b.append(IZQ + linea("="))
    b.append(fila("Mozo: " + Js.str(Js.or(g(pl, "mozo"), "-")), Js.or(g(pl, "hora"), "")))
    b.append(linea())
    for (it in lista(g(pl, "items"))) b.append(fila((fmtCant(g(it, "cantidad")) + " " + Js.str(g(it, "nombre"))).take(ANCHO - 9), money(Js.num(g(it, "cantidad")) * Js.num(g(it, "precio")))))
    b.append(linea("=") + NEG_ON + fila("TOTAL", montoTotal(g(pl, "total"))) + NEG_OFF)
    b.append(linea("=") + CENTRO)
    if (t(pl, "qr")) b.append(qrEscPos(g(pl, "qr")) + "\n")
    b.append("NO ES COMPROBANTE DE PAGO\n" + firma(pl) + CORTE)
    return b.toString()
  }
  private fun renderCartaQr(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO + NEG_ON + GRANDE + Js.str(Js.or(g(pl, "titulo"), "")) + "\n" + NORMAL + NEG_OFF)
    b.append(FONT0 + Js.str(Js.or(g(pl, "sub"), if (KUTI) "Escanea nuestra carta de servicios" else "Escanea nuestro catalogo")) + "\n\n")
    if (t(pl, "url")) b.append(qrEscPos(g(pl, "url"), 8) + "\n")
    b.append(FONT0 + Js.str(Js.or(g(pl, "url"), "")) + "\n")
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  // TICKET familia pos: resto (con mesa) o retail (sin mesa)
  private fun renderTicketPos(pl: Any?): String {
    val retail = !t(pl, "mesa")
    val b = StringBuilder(INIT + CENTRO)
    if (t(pl, "negocio")) b.append(negocioGrande(g(pl, "negocio")))
    b.append(GRANDE + (if (retail) "VENTA\n" else "COBRADO\n") + NORMAL)
    if (!retail) b.append(GRANDE + "MESA " + Js.str(Js.or(g(pl, "mesa"), "-")) + "\n" + NORMAL)
    b.append(IZQ + linea("="))
    if (t(pl, "nota")) b.append("Nota: " + Js.str(g(pl, "nota")) + "\n")
    // [VEN-KIPU F1] ticket de turno de vendedor: aviso si salió por Caja y el código del turno con el local
    if (t(pl, "respaldo") && t(pl, "avisoRespaldo")) b.append(NEG_ON + "(" + Js.str(g(pl, "avisoRespaldo")) + ")" + NEG_OFF + "\n")
    if (t(pl, "turno")) b.append(fila("Turno " + Js.str(g(pl, "turno")), Js.str(Js.or(g(pl, "local"), "")).take(maxOf(0, ANCHO - 12))))
    val quien = Js.or(Js.or(g(pl, "vendedor"), g(pl, "mozo")), "")
    b.append(fila(if (Js.truthy(quien)) (if (retail) "Atendio: " else "Mozo: ") + Js.str(quien) else "", Js.or(g(pl, "hora"), "")))
    b.append(linea())
    for (it in lista(g(pl, "items"))) b.append(fila((fmtCant(g(it, "cantidad")) + " " + Js.str(g(it, "nombre"))).take(ANCHO - 9), money(Js.num(g(it, "cantidad")) * Js.num(g(it, "precio")))))
    b.append(linea("=") + NEG_ON + fila("TOTAL", montoTotal(g(pl, "total"))) + NEG_OFF)
    for (p in pagosDe(pl)) b.append(fila("  " + Js.str(g(p, "medio")), money(g(p, "monto"))))
    if (t(pl, "montosOcultos")) b.append("Medios de pago: al contar la caja\n")
    b.append(linea("=") + CENTRO + "NO ES COMPROBANTE DE PAGO\n")
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  // TICKET familia kuti: nota de venta (servicios con su profesional; propinas aparte)
  private fun renderTicketKuti(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO)
    if (t(pl, "negocio")) b.append(negocioGrande(g(pl, "negocio")))
    if (t(pl, "local")) b.append(Js.str(g(pl, "local")) + "\n")
    b.append(NEG_ON + (if (g(pl, "refTipo") == "ALQUILER") "ALQUILER DE SILLA" else "NOTA DE VENTA") + "\n" + NEG_OFF)
    if (t(pl, "nota")) b.append(GRANDE + Js.str(g(pl, "nota")) + "\n" + NORMAL)
    b.append(IZQ + linea("="))
    b.append(fila("Fecha: " + Js.str(Js.or(Js.or(g(pl, "fecha"), g(pl, "hora")), "")), ""))
    if (t(pl, "vendedor")) b.append("Atendio: " + Js.str(g(pl, "vendedor")) + "\n")
    if (t(pl, "cliente")) b.append("Cliente: " + Js.str(g(pl, "cliente")) + "\n")
    b.append(linea())
    for (it in lista(g(pl, "items"))) {
      b.append(fila(fmtCant(g(it, "cantidad")) + " " + Js.str(g(it, "nombre")), money(Js.num(g(it, "cantidad")) * Js.num(g(it, "precio")))))
      if (t(it, "profesional")) b.append("   - " + Js.str(g(it, "profesional")) + "\n")
    }
    b.append(linea("=") + NEG_ON + fila("TOTAL", montoTotal(g(pl, "total"))) + NEG_OFF)
    for (p in pagosDe(pl)) b.append(fila("  " + Js.str(g(p, "medio")), money(g(p, "monto"))))
    val props = if (t(pl, "montosOcultos")) emptyList() else lista(g(pl, "propinas"))
    if (props.isNotEmpty()) {
      b.append(linea() + "PROPINAS (aparte, no suman al total)\n")
      for (p in props) b.append(fila("  " + Js.str(g(p, "profesional")) + " (" + Js.str(g(p, "medio")) + ")", money(g(p, "monto"))))
    }
    if (t(pl, "montosOcultos")) b.append("Medios de pago: al contar la caja\n")
    b.append(linea("=") + CENTRO + "NO ES COMPROBANTE DE PAGO\n")
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  private fun renderCierre(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO)
    if (t(pl, "negocio")) b.append(NEG_ON + Js.str(g(pl, "negocio")).uppercase() + "\n" + NEG_OFF)
    b.append(GRANDE + "CORTE DE CAJA\n" + NORMAL + IZQ + linea("="))
    for (l in lista(g(pl, "lineas"))) {
      if (Js.truthy(l) && t(l, "sep")) { b.append(linea(Js.str(g(l, "sep")).take(1).ifEmpty { "-" })); continue }
      val f = fila(g(l, "izq"), g(l, "der"))
      b.append(if (t(l, "negrita")) NEG_ON + f + NEG_OFF else f)
    }
    b.append(linea("=") + CENTRO + "Impreso " + Js.str(Js.or(g(pl, "hora"), "")) + "\n")
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  private fun renderCpe(pl: Any?): String {
    val e = Js.or(g(pl, "empresa"), emptyMap<String, Any?>()); val c = Js.or(g(pl, "cliente"), emptyMap<String, Any?>()); val tot = Js.or(g(pl, "totales"), emptyMap<String, Any?>())
    val numero = Js.str(g(pl, "serie")) + "-" + Js.str(g(pl, "numero")).padStart(8, '0')
    val b = StringBuilder(INIT + CENTRO + NEG_ON + Js.str(Js.or(Js.or(g(e, "razonSocial"), g(e, "nombre")), "")) + "\n" + NEG_OFF)
    if (t(e, "ruc")) b.append("RUC " + Js.str(g(e, "ruc")) + "\n")
    if (t(e, "direccion")) b.append(Js.str(g(e, "direccion")) + "\n")
    b.append(linea("=") + NEG_ON + denomCpe(g(pl, "tipo")) + "\n" + GRANDE + numero + "\n" + NORMAL + NEG_OFF)
    if (g(pl, "estado") == "STUB") b.append("*** MODO PRACTICA - SIN VALOR ***\n")
    b.append(IZQ + linea("="))
    b.append(fila("Fecha: " + Js.str(Js.or(g(pl, "fecha"), "")), ""))
    b.append("Cliente: " + Js.str(Js.or(g(c, "nombre"), "CLIENTE VARIOS")) + "\n")
    if (t(c, "doc") && g(c, "doc") != "0") b.append(Js.str(Js.or(g(c, "tipoDoc"), "DOC")) + ": " + Js.str(g(c, "doc")) + "\n")
    if (t(c, "direccion")) b.append(Js.str(g(c, "direccion")) + "\n")
    b.append(linea())
    for (it in listaPos(g(pl, "items"))) {
      val izq = fmtCant(g(it, "cantidad")) + " " + Js.str(g(it, "nombre"))
      b.append(fila(if (KUTI) izq else izq.take(ANCHO - 10), money(g(it, "total"))))
    }
    b.append(linea())
    fun n(x: Any?) = Js.num(Js.or(x, 0.0))
    if (n(g(tot, "gravada")) > 0) b.append(fila("OP. GRAVADA", money(g(tot, "gravada"))))
    if (n(g(tot, "exonerada")) > 0) b.append(fila("OP. EXONERADA", money(g(tot, "exonerada"))))
    if (n(g(tot, "inafecta")) > 0) b.append(fila("OP. INAFECTA", money(g(tot, "inafecta"))))
    if (n(g(tot, "igv")) > 0) b.append(fila("IGV 18%", money(g(tot, "igv"))))
    // [KS-09 ICBPER] bolsas de plástico: aparte del IGV (RS 150-2019/SUNAT), solo si viene
    if (n(g(tot, "icbper")) > 0) b.append(fila("ICBPER (bolsas)", money(g(tot, "icbper"))))
    b.append(NEG_ON + fila("TOTAL", montoTotal(g(pl, "total"))) + NEG_OFF)
    // Monto en letras de la representación impresa (SUNAT); sin un total válido no hay monto que escribir
    b.append(IZQ + (if (totalOk(g(pl, "total"))) "SON: " + numeroALetras(g(pl, "total")) + "\n" else ""))
    for (p in (if (t(pl, "montosOcultos")) emptyList() else listaPos(g(pl, "pagos")))) b.append(fila("  " + Js.str(g(p, "medio")), money(g(p, "monto"))))
    if (t(pl, "montosOcultos")) b.append("Medios de pago: al contar la caja\n")
    b.append(linea("=") + CENTRO)
    if (t(pl, "qr")) b.append(qrEscPos(g(pl, "qr")) + "\n")
    if (t(pl, "hash")) b.append("Hash: " + Js.str(g(pl, "hash")).take(28) + "\n")
    b.append("Representacion impresa del\ncomprobante electronico.\nConsulte en sunat.gob.pe\n")
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  // ---- TURNO (cliente sin cita; KUTI O-23) ----
  private fun numeroTurno(pl: Any?): String {
    val v = if (t(pl, "definitivo")) g(pl, "numero") else Js.or(g(pl, "provisional"), g(pl, "numero"))
    return Js.str(if (Js.nulo(v)) "" else v).filter { it.code in 0x21..0x7e }.take(maxOf(1, ANCHO / 3))
  }
  private fun notasTurno(pl: Any?): List<String> {
    val n = ArrayList<String>()
    if (t(pl, "definitivo")) {
      val dl = g(pl, "delante")
      val d = if (Js.nulo(dl) || dl == "") Double.NaN else Js.num(dl)
      if (d == 0.0) n.add("Es el siguiente en la cola.")
      else if (d == 1.0) n.add("Hay 1 persona delante.")
      else if (!d.isNaN() && !d.isInfinite() && d > 1) n.add("Hay " + Js.numStr(Math.floor(d)) + " personas delante.")
      n.add("Mira la pantalla de la sala: ahi sale tu numero cuando te toque.")
    } else {
      n.add("Numero provisional: se tomo sin internet.")
      n.add("Cuando vuelva la red recibes tu numero de la cola. En la pantalla de la sala lo veras junto a este, por ejemplo:")
      n.add("15 - " + numeroTurno(pl) + " (el 15 es un ejemplo)")
      n.add("No pierdes tu lugar: la cola va por la hora en que llegaste.")
    }
    return n
  }
  private fun renderTurno(pl: Any?): String {
    val b = StringBuilder(INIT + CENTRO)
    val neg = Js.str(Js.or(g(pl, "negocio"), "")); val loc = Js.str(Js.or(g(pl, "local"), ""))
    if (neg.isNotEmpty()) b.append(negocioGrande(neg))
    if (loc.isNotEmpty() && loc != neg) b.append(loc + "\n")
    b.append(NEG_ON + "TURNO SIN CITA" + "\n" + NEG_OFF + linea("="))
    b.append((if (t(pl, "definitivo")) "Tu numero" else "Tu numero provisional") + "\n")
    b.append(NEG_ON + ENORME + numeroTurno(pl) + "\n" + NORMAL + NEG_OFF)
    if (t(pl, "nombre")) b.append(Js.str(g(pl, "nombre")).take(ANCHO) + "\n")
    if (t(pl, "con")) b.append(("Con " + Js.str(g(pl, "con"))).take(ANCHO) + "\n")
    if (t(pl, "fecha") || t(pl, "hora")) b.append(Js.str(Js.or(g(pl, "fecha"), g(pl, "hora"))) + "\n")
    b.append(IZQ + linea())
    for (nota in notasTurno(pl)) for (l in envolver(nota, ANCHO)) b.append(l + "\n")
    b.append(linea("="))
    b.append(firma(pl) + CORTE)
    return b.toString()
  }
  private fun renderBase(tipo: String, pl: Any?): String = when (tipo) {
    "COMANDA" -> renderComanda(pl)
    "PRECUENTA" -> renderPrecuenta(pl)
    "TICKET" -> if (KUTI) renderTicketKuti(pl) else renderTicketPos(pl)
    "CIERRE" -> renderCierre(pl)
    "CPE" -> renderCpe(pl)
    "CARTA_QR" -> renderCartaQr(pl)
    "TURNO" -> renderTurno(pl)
    "PRUEBA" -> INIT + CENTRO + "PRUEBA LEVOPRINT OK\n" + (if (KUTI && t(pl, "estacion")) Js.str(g(pl, "estacion")) + "\n" else "") + firma(pl) + CORTE
    else -> INIT + (Js.stringify(pl, " ") ?: "undefined") + CORTE
  }

  /** render(tipo, payload, ancho, imagen) de render.mjs + el «?» de renderBase64: chars 0..255 listos para latin1. */
  fun render(tipo: Any?, payload: Any?, ancho: Any?, imagen: Any?): String {
    val p = Js.parseInt10(Js.str(Js.or(ancho, "48")))
    ANCHO = Math.min(80.0, Math.max(24.0, if (Js.truthy(p)) p else 48.0)).toInt()
    IMAGEN = imagen != false
    val pl: Any? = Js.or(payload, LinkedHashMap<String, Any?>())
    val tx = renderBase(Js.str(Js.or(tipo, "")), pl)
    return Js.latin1(sellar(tx, pl))
  }
  /** Bytes que van a la impresora (los mismos que la Edge en base64). */
  fun renderBytes(tipo: Any?, payload: Any?, ancho: Any?, imagen: Any?): ByteArray =
    render(tipo, payload, ancho, imagen).toByteArray(Charsets.ISO_8859_1)

  // Copia de un papel que SÍ salió: sello arriba (nadie la toma por un pedido nuevo ni por un segundo cobro).
  private fun sellar(tx: String, pl: Any?): String {
    if (!tx.startsWith(INIT)) return tx
    if (KUTI) {
      if (!(t(pl, "copia") || t(pl, "reimpresion"))) return tx
      return INIT + CENTRO + NEG_ON + GRANDE + "*** COPIA ***\n" + NORMAL + NEG_OFF + IZQ + tx.substring(INIT.length)
    }
    if (!t(pl, "reimpresion") && !t(pl, "atrasada")) return tx
    var sello = CENTRO
    if (t(pl, "atrasada")) sello += NEG_ON + GRANDE + "*** ATRASADA ***\n" + NORMAL + "Pedido de las " + Js.str(Js.or(g(pl, "hora"), "?")) + "\n" + NEG_OFF
    if (t(pl, "reimpresion")) sello += NEG_ON + "*** REIMPRESION ***\n" + NEG_OFF
    return INIT + sello + IZQ + tx.substring(INIT.length)
  }
}
