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
  fun mensajeError(err: String, segundos: Int = 0, app: String = ""): String = when (err) {
    "CODIGO_INVALIDO" -> "El código no es válido. Revisa que esté bien escrito."
    "CODIGO_VENCIDO" -> "El código venció (dura 15 min). Genera uno nuevo en la consola (Estaciones)."
    "CODIGO_USADO" -> "Ese código ya se usó. Genera uno nuevo en la consola (Estaciones)."
    "OTRA_APP" -> "Este código es de " + nombreApp(app) + ". Genera el código en la consola de la app donde quieres imprimir."
    "AGENTE_YA_VINCULADO" -> "Otro equipo se vinculó a este local mientras tanto. Genera un código nuevo en la consola (Estaciones)."
    "DEMASIADOS_INTENTOS" -> "Hubo demasiados intentos con códigos equivocados. " + textoEspera(segundos)
    "IP_DESCONOCIDA" -> "No se pudo identificar la conexión. Intenta de nuevo."
    "AGENTE_INVALIDO" -> MSG_REEMPLAZADO
    "CODIGO_FORMATO" -> "El código tiene 9 caracteres y empieza con K (KOMO) o P (KIPU). Revisa que esté bien escrito."
    "CODIGO_RESERVADO" -> "Este código es de " + nombreApp(app) + ", que esta versión de LevoPrint todavía no admite. Actualiza LevoPrint e intenta de nuevo."
    "SIN_CODIGO" -> "Escribe el código de 9 caracteres."
    "RED" -> "No se pudo conectar. Revisa tu internet e intenta de nuevo."
    "RESPUESTA_INCOMPLETA" -> "El servidor respondió sin los datos necesarios. Intenta de nuevo."
    else -> "No se pudo emparejar ($err)."
  }

  const val MSG_REEMPLAZADO = "Este equipo fue reemplazado o desactivado; vincúlalo de nuevo con un código de la consola (Estaciones)."

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
        CanjeResultado.Error(err, mensajeError(err, r.optInt("segundos", 0), r.optString("app")))
      }
    } catch (e: Exception) {
      CanjeResultado.Error("RED", mensajeError("RED"))
    }
  }
}
