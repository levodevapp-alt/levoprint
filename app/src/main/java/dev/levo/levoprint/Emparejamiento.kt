package dev.levo.levoprint

import android.net.Uri
import org.json.JSONObject

// Emparejamiento por codigo de 9 caracteres (tecleado o via QR), en vez de
// pegar URL/anon/device a mano. Contrato con el backend (RPC publica
// "<prefijo>_estacion_codigo_canjear", modulo levoprint rev 4, ver
// levodev-modules docs/LEVOPRINT.md):
//   POST <url>/rest/v1/rpc/<prefijo>_estacion_codigo_canjear
//   body {"p":{"codigo":"KXXXXXXXX"}}
//   -> { ok, url, anon, prefijo, device, ancho, nombre, modo, reemplazara, reemplazados, reintento? }
//   -> { ok:false, error: CODIGO_INVALIDO | CODIGO_VENCIDO | CODIGO_USADO |
//        OTRA_APP (+ app) | AGENTE_YA_VINCULADO | IP_DESCONOCIDA |
//        DEMASIADOS_INTENTOS (+ segundos) }
//
// [canje-v4] Formato del codigo: <letra de la app> + 8 del alfabeto sin
// ambiguos (31 simbolos, sin 0/O/1/I/L). K = KOMO, P = KIPU, T = reservada
// para KUTI. La LETRA dice a que proyecto llamar: ya no se prueba komo y
// luego kipu. Importa porque cada CODIGO_INVALIDO suma al freno por IP del
// proyecto. Un codigo con formato malo (o letra que este build no conoce)
// se rechaza AQUI, sin gastar un intento en el servidor.
//
// Exito: "modo" (nuevo|reemplazar|adicional); "reemplazara" = equipos que
// se apagaran cuando ESTE imprima su primer trabajo (hasta entonces los dos
// imprimen); "reemplazados" vale 0 en el canje. "reintento": true si es el
// recanje idempotente (misma IP, menos de 3 min).
sealed class CanjeResultado {
  data class Ok(
    val cfg: Cfg, val nombre: String,
    val modo: String = "", val reemplazara: Int = 0, val reintento: Boolean = false
  ) : CanjeResultado()
  data class Error(val codigo: String, val mensaje: String) : CanjeResultado()
}

data class DatosLink(val codigo: String, val prefijo: String?, val url: String?, val anon: String?)

object Emparejamiento {
  // Mismo patron que el servidor (rev 4).
  private val FORMATO = Regex("^[KPT][ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$")

  // Letra -> nombre visible de la app (para OTRA_APP y la letra reservada).
  fun nombreApp(letra: String): String = when (letra.uppercase()) {
    "K" -> "KOMO"
    "P" -> "KIPU"
    "T" -> "KUTI"
    else -> letra.uppercase()
  }

  // Mensajes para el dueno (no tecnico). "segundos" solo aplica a
  // DEMASIADOS_INTENTOS y "app" (la letra) a OTRA_APP / CODIGO_RESERVADO;
  // ambos vienen del servidor o del chequeo local.
  // "prefijo" y "seccion" (rev 5) arman el nombre de la consola (consolaDe).
  fun mensajeError(err: String, segundos: Int = 0, app: String = "", prefijo: String = "", seccion: String = ""): String = when (err) {
    "CODIGO_INVALIDO" -> "El código no es válido. Revisa que esté bien escrito."
    "CODIGO_VENCIDO" -> "El código venció (dura 15 min). Genera uno nuevo en " + consolaDe(prefijo, seccion) + "."
    "CODIGO_USADO" -> "Ese código ya se usó. Genera uno nuevo en " + consolaDe(prefijo, seccion) + "."
    "OTRA_APP" -> "Este código es de " + nombreApp(app) + ". Genera el código en la consola de la app donde quieres imprimir."
    "AGENTE_YA_VINCULADO" -> "Otro equipo se vinculó a este local mientras tanto. Genera un código nuevo en " + consolaDe(prefijo, seccion) + "."
    "DEMASIADOS_INTENTOS" -> "Hubo demasiados intentos con códigos equivocados. " + textoEspera(segundos)
    "IP_DESCONOCIDA" -> "No se pudo identificar la conexión. Intenta de nuevo."
    "AGENTE_INVALIDO" -> msgDesactivado(prefijo)
    "CODIGO_FORMATO" -> "El código tiene 9 caracteres y empieza con K (KOMO) o P (KIPU). Revisa que esté bien escrito."
    "CODIGO_RESERVADO" -> "Este código es de " + nombreApp(app) + ", que esta versión de LevoPrint todavía no admite. Actualiza LevoPrint e intenta de nuevo."
    "SIN_CODIGO" -> "Escribe el código de 9 caracteres."
    "RED" -> "No se pudo conectar. Revisa tu internet e intenta de nuevo."
    "RESPUESTA_INCOMPLETA" -> "El servidor respondió sin los datos necesarios. Intenta de nuevo."
    else -> "No se pudo emparejar ($err)."
  }

  // [qa4] La pantalla se llama "Estaciones" en KOMO e "Impresoras" en KIPU.
  // Rev 5: toda respuesta de canjear trae "seccion"; manda esa. Si no viene
  // (o el mensaje no sale de un canje, como el de desactivado), se usa la
  // ultima vista para ese prefijo mientras viva el proceso o, si no, la conocida.
  private val seccionVista = java.util.concurrent.ConcurrentHashMap<String, String>()

  fun consolaDe(prefijo: String, seccion: String = ""): String {
    val pfx = prefijo.lowercase()
    val app = when (pfx) { "komo" -> "KOMO"; "kipu" -> "KIPU"; else -> pfx.uppercase() }
    val sec = seccion.trim().ifBlank {
      seccionVista[pfx] ?: when (pfx) { "komo" -> "Estaciones"; "kipu" -> "Impresoras"; else -> "" }
    }
    return when {
      app.isNotBlank() && sec.isNotBlank() -> "tu consola de $app › $sec"
      app.isNotBlank() -> "tu consola de $app"
      else -> "tu consola"
    }
  }

  // [qa5] Texto visible del modo desactivado: aviso base y, pasada una hora,
  // cuanto lleva (equipo olvidado).
  fun textoDesactivado(prefijo: String, desde: Long): String {
    val horas = if (desde > 0) ((System.currentTimeMillis() - desde) / 3600000L).toInt() else 0
    return msgDesactivado(prefijo) + if (horas >= 1)
      " Lleva $horas ${if (horas == 1) "hora" else "horas"} desactivado; si ya no se usa, puedes cerrar LevoPrint."
    else ""
  }

  // [qa4] AGENTE_INVALIDO: el token se conserva y el servicio reintenta solo.
  fun msgDesactivado(prefijo: String): String =
    "Este equipo está desactivado desde la consola; si lo reactivan vuelve a imprimir solo. " +
      "Para vincularlo de nuevo, ingresa un código nuevo de " + consolaDe(prefijo) + "."

  private fun textoEspera(seg: Int): String =
    if (seg > 0) "Espera $seg ${if (seg == 1) "segundo" else "segundos"} y vuelve a intentar."
    else "Espera un momento y vuelve a intentar."

  // Texto del exito segun modo/reemplazara (el reemplazo se aplica en el
  // PRIMER trabajo impreso del equipo nuevo, no al vincular).
  fun textoExito(r: CanjeResultado.Ok): String = "Emparejado como " + r.nombre + when {
    r.modo == "reemplazar" && r.reemplazara == 1 -> ". Cuando imprimas tu primera comanda, se apagará el equipo anterior."
    r.modo == "reemplazar" && r.reemplazara > 1 -> ". Cuando imprimas tu primera comanda, se apagarán los " + r.reemplazara + " equipos anteriores."
    r.modo == "adicional" -> ". Quedó como equipo adicional."
    else -> "."
  }

  // Codigo normalizado igual que el servidor: mayusculas y sin espacios
  // (incluye saltos de linea CR/LF de un copiar/pegar).
  fun normalizar(codigo: String): String = codigo.uppercase().filter { !it.isWhitespace() }

  // "levoprint://emparejar?c=KXXXXXXXX&p=komo" (o el equivalente https, por
  // si la consola cambia el esquema del QR) -> DatosLink. null si no trae codigo.
  fun parseLink(uri: Uri): DatosLink? {
    val c = uri.getQueryParameter("c")?.let { normalizar(it) }
    if (c.isNullOrBlank()) return null
    fun q(k: String) = uri.getQueryParameter(k)?.trim()?.ifBlank { null }
    return DatosLink(codigo = c, prefijo = q("p"), url = q("u"), anon = q("a"))
  }

  fun canjear(
    codigoIn: String,
    prefijoForzado: String? = null,
    urlForzada: String? = null,
    anonForzado: String? = null
  ): CanjeResultado {
    val cod = normalizar(codigoIn)
    if (cod.isBlank()) return CanjeResultado.Error("SIN_CODIGO", mensajeError("SIN_CODIGO"))
    if (!FORMATO.matches(cod)) return CanjeResultado.Error("CODIGO_FORMATO", mensajeError("CODIGO_FORMATO"))
    val letra = cod.substring(0, 1)

    // Proyecto por la LETRA (un solo intento). El p= del QR es redundante con
    // la letra; si algun dia difieren, manda la letra (el servidor igual
    // responderia OTRA_APP). url+anon forzados en el link solo se usan si el
    // prefijo coincide con el de la letra.
    val conocido = Proyectos.porLetra(letra)
      ?: return CanjeResultado.Error("CODIGO_RESERVADO", mensajeError("CODIGO_RESERVADO", app = letra))
    val p = if (urlForzada != null && anonForzado != null &&
                (prefijoForzado == null || prefijoForzado.equals(conocido.prefijo, ignoreCase = true)))
      conocido.copy(url = urlForzada, anon = anonForzado)
    else conocido

    return try {
      val sonda = Cfg(p.url, p.anon, "", p.prefijo, 48)
      val r = Agent.rpc(sonda, p.prefijo + "_estacion_codigo_canjear", JSONObject().put("codigo", cod))
      val seccion = r.optString("seccion").trim()
      if (seccion.isNotBlank()) seccionVista[p.prefijo.lowercase()] = seccion
      if (r.optBoolean("ok")) {
        val ancho = r.optString("ancho", "48").toIntOrNull() ?: 48
        val cfg = Cfg(
          url = r.optString("url").ifBlank { p.url },
          anon = r.optString("anon").ifBlank { p.anon },
          device = r.optString("device"),
          prefijo = r.optString("prefijo").ifBlank { p.prefijo },
          ancho = ancho
        )
        if (cfg.device.isBlank()) CanjeResultado.Error("RESPUESTA_INCOMPLETA", mensajeError("RESPUESTA_INCOMPLETA"))
        else CanjeResultado.Ok(
          cfg, r.optString("nombre").ifBlank { "Estación" },
          modo = r.optString("modo"),
          reemplazara = r.optInt("reemplazara", 0),
          reintento = r.optBoolean("reintento", false)
        )
      } else {
        val err = r.optString("error", "ERROR")
        CanjeResultado.Error(err, mensajeError(err, r.optInt("segundos", 0), r.optString("app"), p.prefijo, seccion))
      }
    } catch (e: Exception) {
      CanjeResultado.Error("RED", mensajeError("RED"))
    }
  }
}
