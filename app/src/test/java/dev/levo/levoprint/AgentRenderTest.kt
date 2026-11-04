package dev.levo.levoprint

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Render local del APK:
//  1) KOMO y KIPU: BYTE A BYTE igual que canje-v3 (copia congelada en
//     dev.levo.levoprint.original.Agent), en 4 anchos y con los sellos de
//     siempre (mismos casos que la comparacion del .exe, cmprender.mjs de QA).
//  2) KUTI: nota de venta (VENTA / ALQUILER DE SILLA, nota, quien atendio,
//     cliente, profesional por servicio, propinas aparte), COPIA y corte.
//  3) [O-23] KUTI: ticket del cliente sin cita (TURNO), definitivo y provisional.
class AgentRenderTest {
  private fun o(s: String) = JSONObject(s)
  // Payload + extras (las extras pisan claves del payload, como el spread del .exe).
  private fun m(s: String, extra: String): JSONObject {
    val a = o(s)
    if (extra.isNotEmpty()) { val e = o("{" + extra.substring(1) + "}"); for (k in e.keys()) a.put(k, e.get(k)) }
    return a
  }
  private fun job(tipo: String, pl: JSONObject) = JSONObject().put("tipo", tipo).put("payload", pl)

  // Texto impreso sin los comandos ESC/POS (ESC @, ESC a n, ESC E n, ESC ! n, GS ! n, GS V n).
  private fun texto(t: String): String {
    // [MM3-01] el isotipo (GS v 0 + 512 bytes de mapa de bits) tambien se quita: queda solo el texto impreso
    val i = t.indexOf(RASTER)
    val sinImg = if (i < 0) t else t.substring(0, i) + t.substring(i + RASTER.length + 512)
    return sinImg.replace(Regex("\u001b@|\u001b[aE!J][\\s\\S]|\u001d[!V][\\s\\S]"), "")
  }
  // Cabecera GS v 0 m xL xH yL yH del isotipo de 64x64 puntos (8 bytes por fila): 1D 76 30 00 08 00 40 00
  private val RASTER = 29.toChar() + "v0" + 0.toChar() + 8.toChar() + 0.toChar() + 64.toChar() + 0.toChar()
  private val PROHIBIDO = listOf("Paracas", "Peru", "Ica", "Pisco", "Luis", "S/ 39", "S/ 40", "Tu negocio tambien", "Sistema ", "<Levodev", "Hecho con carino")

  private val items = """[{"cantidad":2,"nombre":"Lomo saltado","precio":28.5},{"cantidad":0.5,"nombre":"Arroz extra largo nombre de plato de prueba","precio":10.01}]"""
  private val base = """"negocio":"Chifa X","hora":"13:05","fecha":"24/10/2026 13:05","items":$items,"total":62.01,"pagos":[{"medio":"Efectivo","monto":62.01}],"app":"KOMO","lema":"POS""""

  private fun casosKomoKipu(): List<JSONObject> {
    val r = ArrayList<JSONObject>()
    for (extra in listOf("", ""","reimpresion":true""", ""","atrasada":true,"hora":"12:00"""", ""","reimpresion":true,"atrasada":true""")) {
      r.add(job("TICKET", m("""{$base,"mesa":"5","mozo":"Ana"}""", extra)))
      r.add(job("TICKET", m("""{$base,"nota":"NV-1","vendedor":"Luis"}""", extra)))
      r.add(job("COMANDA", m("""{"mesa":"3","mozo":"Ana","items":$items,"hora":"12:30","ronda":2,"mensaje":"sin aji","nota":"rapido"}""", extra)))
      r.add(job("PRECUENTA", m("""{$base,"mesa":"3","cuenta":{"n":1,"de":2},"qr":"x"}""", extra)))
      r.add(job("CPE", m("""{"tipo":"BOLETA DE VENTA ELECTRONICA","serie":"B001","numero":7,"estado":"EMITIDO","empresa":{"razonSocial":"X SAC","ruc":"20123456789","direccion":"Av 1"},"cliente":{"nombre":"Juan","doc":"12345678","tipoDoc":"DNI"},"mesa":"4","mozo":"Ana","items":[{"cantidad":1,"nombre":"Lomo","total":28.5}],"totales":{"gravada":24.15,"igv":4.35},"total":28.5,"pagos":[{"medio":"Efectivo","monto":28.5}],"qr":"a|b","hash":"abcdefghijklmnopqrstuvwxyz0123456789"}""", extra)))
      r.add(job("CARTA_QR", m("""{"titulo":"Carta","url":"https://x.y/z"}""", extra)))
      r.add(job("PRUEBA", m("""{"x":1}""", extra)))
      r.add(job("CIERRE", m("""{"caja":"x","total":5,"items":$items}""", extra)))
      r.add(job("OTRO", m("""{"items":$items}""", extra)))
    }
    return r
  }

  @Test fun komoYKipuByteAByteIgualQueCanjeV3() {
    var n = 0
    for (ancho in listOf(32, 42, 48, 64)) for (j in casosKomoKipu()) {
      n++
      // [MM3-01 · MM3-P1] el pie de marca de la copia congelada es un marcador: se cambia por el vigente
      // (con imagen); el resto, byte a byte. La COMANDA tiene jerarquia nueva y sus propias pruebas.
      if (j.optString("tipo") == "COMANDA") continue
      val orig = dev.levo.levoprint.original.Agent.render(j, ancho).replace("@@PIE@@", Agent.pieConImagen("KOMO", ancho, true))
      assertEquals("difiere ${j.optString("tipo")} ancho $ancho", orig, Agent.render(j, ancho, "KOMO"))
    }
    assertEquals(144, n)
  }

  private val kuti = """{"app":"KUTI","lema":"Turnos y caja para barberias y salones","ticket":"t","refTipo":"DIRECTO","nota":"NV01-00000042","negocio":"Barbería Demo","local":null,"hora":"18:30","fecha":"24/10/2026 18:30","vendedor":"Jorge, Luis","cliente":null,"items":[{"cantidad":1.000,"nombre":"Perfilado","precio":13.00,"profesional":"Jorge"},{"cantidad":2.000,"nombre":"Ceja","precio":10.01,"profesional":"Luis"},{"cantidad":1,"nombre":"Descuento","precio":-5.01}],"total":28.01,"pagos":[{"medio":"Efectivo","monto":28.01}],"propinas":[{"profesional":"Luis","medio":"Yape","monto":5.00}],"propinaTotal":5.00}"""

  @Test fun kutiNotaDeVenta() {
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.render(job("TICKET", o(kuti)), ancho))
      assertTrue(t, t.contains("BARBERÍA DEMO") && t.contains("VENTA") && t.contains("Nota: NV01-00000042"))
      assertTrue(t, t.contains("Atendio: Jorge, Luis") && !t.contains("Cliente:") && !t.contains("MESA") && !t.contains("Mozo") && !t.contains("null"))
      assertTrue(t, t.contains("1 Perfilado") && t.contains("   - Jorge") && t.contains("   - Luis") && t.contains("S/ -5.01") && t.contains("S/ 20.02"))
      assertTrue(t, t.contains("S/ 28.01") && t.contains("PROPINAS (aparte, no suman al total)") && t.contains("Luis (Yape)") && t.contains("S/ 5.00"))
      assertFalse(t, t.contains("COPIA"))
    }
  }

  @Test fun kutiAlquilerCopiaYCorte() {
    val alq = o(kuti).put("refTipo", "ALQUILER").put("vendedor", JSONObject.NULL).put("cliente", "Ana").put("propinas", JSONArray())
    val t = texto(Agent.render(job("TICKET", alq), 48))
    assertTrue(t, t.contains("ALQUILER DE SILLA") && t.contains("Cliente: Ana") && !t.contains("Atendio") && !t.contains("PROPINAS") && !t.contains("null"))
    val c = texto(Agent.render(job("TICKET", o(kuti).put("copia", true).put("reimpresion", true)), 48))
    assertTrue(c, c.startsWith("*** COPIA ***") && c.contains("NV01-00000042"))
    val k = texto(Agent.render(job("CIERRE", o("""{"negocio":"Barbería Demo","lineas":[{"izq":"Ventas (3)","der":"S/ 105.00","negrita":true},{"sep":"-"},{"izq":"Diferencia","der":"S/ -0.50"}]}""")), 32))
    assertTrue(k, k.contains("CORTE DE CAJA") && k.contains("Ventas (3)") && k.contains("S/ -0.50") && k.contains("-".repeat(32)))
  }

  // [MM3-01 · MM3-P1] Pie de marca: el nombre sale de la configuracion del local (prefijo), si no del payload.
  // Isotipo en 1 bit + "Hecho con <APP> - levodev.app" + lema; ASCII puro; sin ciudades, pais, precios ni gancho.
  @Test fun pieDeMarcaPorApp() {
    val lema48 = "Tu negocio, inteligente y bajo control.\n"
    val lema32 = "Tu negocio, inteligente\ny bajo control.\n"
    assertEquals("Hecho con KUTI - levodev.app\n" + lema48, Agent.pieTexto("kuti"))
    assertEquals("Hecho con KIPU - levodev.app\n" + lema48, Agent.pieTexto("KIPU"))
    assertEquals("LevoDev - levodev.app\n" + lema48, Agent.pieTexto("otra"))
    assertEquals("Hecho con KOMO - levodev.app\n" + lema32, Agent.pieTexto("komo", 32))
    for (an in listOf(32, 42, 48, 64)) for (l in Agent.pieTexto("kipu", an).split("\n")) assertTrue(l, l.length <= an)
    for (ap in listOf("komo", "kipu", "kuti", "x")) for (an in listOf(32, 48)) assertTrue(Agent.pieTexto(ap, an).all { it.code < 128 })
    // con imagen: GS v 0, 64x64, 512 bytes de mapa, y debajo el mismo texto
    val con = Agent.pieConImagen("KUTI", 48, true)
    assertTrue(con.startsWith(27.toChar() + "J" + 8.toChar() + RASTER) && con.endsWith(27.toChar() + "J" + 6.toChar() + Agent.pieTexto("KUTI", 48)))
    assertEquals(3 + RASTER.length + 512 + 3 + Agent.pieTexto("KUTI", 48).length, con.length)
    assertEquals(63.toChar(), con[3 + RASTER.length]) // primer byte del mapa (0x3f): la L y el punto
    assertEquals(Agent.pieTexto("KUTI", 48), Agent.pieConImagen("KUTI", 48, false))
    for (app in listOf("komo", "kipu", "kuti")) for (an in listOf(32, 48)) for (tipo in listOf("PRUEBA", "TICKET", "PRECUENTA", "CARTA_QR")) {
      val pl = o("""{"negocio":"Pollos Don Lucho","mesa":"3","items":$items,"total":28.5,"pagos":[],"qr":"q","url":"https://x.y","lema":"Turnos y caja para barberias y salones"}""")
      val t = Agent.render(job(tipo, pl), an, app)
      val s = texto(t)
      assertTrue("$app $tipo $an: un solo isotipo", t.indexOf(RASTER) > 0 && t.indexOf(RASTER) == t.lastIndexOf(RASTER))
      assertTrue(s, s.contains(Agent.pieTexto(app, an)) && !s.contains("barberias") && PROHIBIDO.none { t.contains(it) })
      // fallback sin imagen (interruptor del equipo o payload.sinImagen): el mismo pie en texto
      val x = Agent.render(job(tipo, pl), an, app, false)
      assertFalse(x.contains(29.toChar() + "v0"))
      assertEquals(s, texto(x))
      assertEquals(x, Agent.render(job(tipo, JSONObject(pl.toString()).put("sinImagen", true)), an, app))
    }
    // el ticket es del negocio: su nombre va arriba y la marca al pie (KOMO/KIPU del APK no imprimen negocio, congelado desde canje-v3)
    val tk = texto(Agent.render(job("TICKET", o(kuti)), 48, "kuti"))
    assertTrue(tk, tk.indexOf("BARBERÍA DEMO") in 0 until tk.indexOf("Hecho con KUTI"))
    val p = Agent.render(job("PRUEBA", o("""{"app":"KUTI"}""")), 32)
    assertTrue(p, texto(p).contains("Hecho con KUTI - levodev.app"))
  }

  // [MM3-01 · 4-nov] Comanda con jerarquia y SIN pie: MESA enorme, mozo y hora en negrita, items en doble alto.
  @Test fun comandaJerarquiaYSinPie() {
    val alto = 29.toChar() + "!" + 1.toChar()
    for (ancho in listOf(32, 48)) {
      val pl = o("""{"mesa":"12","mozo":"Ana","hora":"19:42","ronda":2,"lema":"POS","items":[{"cantidad":2,"nombre":"Lomo saltado con arroz chaufa y una porcion extra de papas fritas","nota":"sin cebolla"},{"cantidad":1.5,"nombre":"Chicha"}]}""")
      val t = Agent.render(job("COMANDA", pl), ancho, "komo")
      assertTrue(t, t.contains(29.toChar() + "!" + 34.toChar() + "MESA 12" + "\n") && t.contains("Mozo: Ana") && t.contains("19:42") && t.contains("Ronda 2"))
      assertTrue(t, t.contains(27.toChar() + "E" + 1.toChar() + alto + "2 x Lomo saltado") && Regex(alto + " {4}\\S").containsMatchIn(t))
      assertTrue(t, t.contains(">> sin cebolla") && t.contains("1.500 x Chicha"))
      assertTrue(texto(t), texto(t).split("\n").all { it.length <= ancho })
      assertFalse(t, t.contains("Hecho con") || t.contains("levodev.app") || t.contains(RASTER) || t.contains("Tu negocio") || t.contains("POS" + "\n"))
      assertTrue(t, t.endsWith("=".repeat(ancho) + "\n\n\n\n" + 29.toChar() + "V" + 0.toChar()))
    }
    val c = texto(Agent.render(job("COMANDA", o("""{"mesa":"5","correccion":true,"items":[{"cantidad":1,"nombre":"Lomo"}]}""")), 48, "komo"))
    assertTrue(c, c.contains("*** CORRECCION ***\nMESA 5\n"))
  }

  // [O-23] Ticket del cliente sin cita de KUTI (TURNO): mismo papel que kuti-print (prueba_render.mjs).
  private val turnoDef = """{"app":"KUTI","negocio":"Barbería Demo","local":"Sede Centro","definitivo":true,"numero":15,"provisional":"","nombre":"Carlos P.","con":"Jorge","fecha":"04/11/2026 10:05","delante":2}"""

  @Test fun kutiTurnoDefinitivo() {
    for (ancho in listOf(32, 48)) {
      val crudo = Agent.render(job("TURNO", o(turnoDef)), ancho, "kuti")
      val t = texto(crudo)
      assertTrue(t, t.contains("BARBERÍA DEMO") && t.contains("Sede Centro") && t.contains("TURNO SIN CITA") && t.contains("Tu numero\n15\n"))
      // triple alto (GS ! 0x22) para el numero
      assertTrue(crudo, crudo.contains(29.toChar() + "!" + 34.toChar() + "15\n"))
      assertTrue(t, t.contains("Carlos P.\nCon Jorge\n04/11/2026 10:05\n") && t.contains("Hay 2 personas delante.") && !t.contains("null") && !t.contains("COPIA"))
      assertTrue(t, t.contains("Hecho con KUTI - levodev.app"))
      // [QA BAJO] sin punto ciego: ninguna linea pasa del ancho, el negocio (doble ancho) tampoco; lo fijo es ASCII puro
      assertTrue(t, t.split("\n").all { it.length <= ancho } && t.split("\n")[0].length * 2 <= ancho)
      val fijo = t.substring(t.indexOf("TURNO SIN CITA")).replace("Carlos P.", "").replace("Jorge", "")
      assertTrue(fijo, fijo.all { it.code < 128 })
    }
    val cero = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", 0)), 48, "kuti"))
    assertTrue(cero, cero.contains("Es el siguiente en la cola."))
    val uno = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", 1)), 48, "kuti"))
    assertTrue(uno, uno.contains("Hay 1 persona delante."))
    val raro = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", "x")), 48, "kuti"))
    assertTrue(raro, !raro.contains("siguiente") && !raro.contains("delante."))
  }

  @Test fun kutiTurnoProvisionalYCopia() {
    val prov = o(turnoDef).put("definitivo", false).put("numero", "A-07").put("provisional", "A-07").put("nombre", "").put("con", JSONObject.NULL).put("delante", JSONObject.NULL)
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.render(job("TURNO", prov), ancho, "kuti"))
      val u = t.replace("\n", " ")
      assertTrue(t, t.contains("Tu numero provisional\nA-07\n") && u.contains("se tomo sin internet") && t.contains("\n15 - A-07 (el 15 es un ejemplo)\n"))
      assertTrue(t, u.contains("No pierdes tu lugar") && !t.contains("Con ") && !t.contains("delante") && !t.contains("null"))
      assertTrue(t, t.split("\n").all { it.length <= ancho })
    }
    val c = texto(Agent.render(job("TURNO", o(turnoDef).put("copia", true)), 48, "kuti"))
    assertTrue(c, c.startsWith("*** COPIA ***") && c.contains("TURNO SIN CITA"))
    // el numero grande solo lleva ASCII visible y cabe en triple (32 columnas -> 10)
    val largo = texto(Agent.render(job("TURNO", prov.put("provisional", "ZZZZ-9999·xx")), 32, "kuti"))
    assertTrue(largo, largo.contains("\nZZZZ-9999x\n"))
  }

  // [QA BAJO] un negocio largo va en doble ancho: se corta a la mitad de las columnas
  @Test fun kutiTurnoNegocioLargo() {
    for (ancho in listOf(32, 48)) {
      val pl = o(turnoDef).put("negocio", "Barbería y Spa Los Hermanos del Centro Histórico")
      val primera = texto(Agent.render(job("TURNO", pl), ancho, "kuti")).split("\n")[0]
      assertTrue(primera, primera.length <= ancho / 2 && primera.startsWith("BARBERÍA Y SPA"))
    }
  }

  // [QA MEDIO-2] La versión que manda el APK (agente_config p.version) es la de app/build.gradle.kts (versionName)
  @Test fun versionIgualAlGradle() {
    val f = listOf(java.io.File("build.gradle.kts"), java.io.File("app/build.gradle.kts")).first { it.exists() }
    val m = Regex("versionName\\s*=\\s*\"([^\"]+)\"").find(f.readText())
    assertEquals(m?.groupValues?.get(1), Agent.VERSION)
    assertEquals("1.7.0", Agent.VERSION)
    val vc = Regex("versionCode\\s*=\\s*(\\d+)").find(f.readText())
    assertEquals(vc?.groupValues?.get(1)?.toInt(), Agent.VERSION_CODE)
  }

  @Test fun envolverPorPalabra() {
    assertEquals(listOf("hola que", "tal"), Agent.envolver("hola  que tal", 8))
    assertEquals(listOf("abcdefgh", "ij x"), Agent.envolver("abcdefghij x", 8))
    assertEquals(emptyList<String>(), Agent.envolver("   ", 8))
  }

  // [MM4-06] Papel al vincular: titulo, estacion y negocio en lineas aparte (sin el punto medio), hora y pie.
  @Test fun papelVinculado() {
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.renderVinculado("Cocina · Pollería Doña Ana", "03/11/2026 21:05", ancho, "komo"))
      assertTrue(t, t.contains("LevoPrint\nVINCULADO\n") && t.contains("Cocina\nPollería Doña Ana\n") && t.contains("03/11/2026 21:05"))
      assertTrue(t, !t.contains("·") && t.contains("Hecho con KOMO - levodev.app") && t.contains("Tu negocio, inteligente"))
      assertTrue(t, t.split("\n").all { it.length <= ancho })
    }
  }

  // [QA M1 · 4-nov] Un item sin nombre sale igual, con su cantidad.
  @Test fun comandaItemSinNombre() {
    for (ancho in listOf(32, 48)) {
      val t = Agent.render(job("COMANDA", o("""{"mesa":"3","items":[{"cantidad":2,"nombre":""},{"cantidad":1},{"cantidad":1,"nombre":"   "},{"cantidad":1,"nombre":"Chicha"}]}""")), ancho, "komo")
      assertTrue(t, t.contains("2 x (sin nombre)") && Regex("\\(sin nombre\\)").findAll(t).count() == 3 && t.contains("1 x Chicha"))
    }
  }

  // [QA M2 · 4-nov] El nombre del negocio en doble ancho se parte en varios renglones: nunca pierde un caracter ni pasa del ancho.
  @Test fun negocioLargoEnDobleAncho() {
    val negocios = listOf("Pollería Don Lucho", "Distribuidora Inversiones Santa Rosa SAC", "Cevichería y Pollería Los Hermanos del Centro Histórico", "Supercalifragilisticoespialidosoextraordinariamente SAC")
    val grande = 29.toChar() + "!" + 17.toChar()
    for (ancho in listOf(32, 48)) for (neg in negocios) for (tipo in listOf("TICKET", "TURNO")) {
      val pl = o(kuti).put("negocio", neg).put("local", JSONObject.NULL).put("definitivo", true).put("numero", 15)
      val t = Agent.render(job(tipo, pl), ancho, "kuti")
      val cab = t.substring(0, t.indexOf("====="))
      val lineas = cab.split("\n")
      val limpia = { l: String -> l.replace(Regex("\u001b@|\u001b[aEJ!][\\s\\S]|\u001d![\\s\\S]"), "") }
      assertTrue(cab, lineas.all { l -> limpia(l).length <= (if (l.contains(grande)) ancho / 2 else ancho) })
      val plano = lineas.joinToString("") { limpia(it) }.replace(Regex("\\s"), "")
      assertTrue("$tipo $ancho: $cab", plano.contains(neg.uppercase().replace(Regex("\\s"), "")))
    }
  }

  // [Re-QA BAJO-1] el ancho valido es 20-100: nunca <= 0 (chunked(0) lanzaba) ni absurdo, al guardar y al usar.
  @Test fun anchoValidoYRenderConAnchosAbsurdos() {
    assertEquals(20, Agent.anchoValido(-10)); assertEquals(20, Agent.anchoValido(0)); assertEquals(20, Agent.anchoValido(1))
    assertEquals(48, Agent.anchoValido(48)); assertEquals(100, Agent.anchoValido(999))
    for (an in listOf(-10, 0, 1, 999)) {
      val pl = o(kuti).put("negocio", "Supercalifragilisticoespialidosoextraordinariamente SAC")
      val t = Agent.render(job("TICKET", pl), an, "kuti")
      // el nombre entero, aunque parta la palabra larga a lo ancho (sin separadores)
      assertTrue("ancho $an", texto(t).replace("\n", "").contains("SUPERCALIFRAGILISTICOESPIALIDOSOEXTRAORDINARIAMENTE") && t.contains("VENTA"))
      assertTrue(Agent.render(job("COMANDA", o("""{"mesa":"3","items":[{"cantidad":1,"nombre":"YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY"}]}""")), an, "komo").contains("1 x Y"))
    }
    assertEquals(listOf("a", "b"), Agent.envolver("a b", 0))
  }

  // [Re-QA BAJO-4] el espacio duro (NBSP) corta palabras como en JS; las mayusculas fuera de latin1 salen "?"; a 24 columnas el pie cabe.
  @Test fun nbspMayusculasYPieA24() {
    assertEquals(listOf("hola que", "tal"), Agent.envolver("hola" + 160.toChar() + "que tal", 8))
    val t = Agent.render(job("TICKET", o(kuti).put("negocio", "Ωmega" + 160.toChar() + "Barbería")), 48, "kuti", false)
    assertTrue(t, t.contains("?MEGA") && t.contains("BARBER") && t.none { it.code > 255 })
    for (an in listOf(24, 20)) {
      val p = Agent.render(job("PRUEBA", o("""{"app":"KOMO"}""")), an, "komo", false)
      val pie = texto(p).let { it.substring(it.indexOf("Hecho con ")) }.split("\n").take(if (an == 24) 4 else 5)
      assertTrue(pie.toString(), pie.all { it.length <= an } && texto(p).contains("Hecho con KOMO\nlevodev.app\n"))
    }
  }
}
