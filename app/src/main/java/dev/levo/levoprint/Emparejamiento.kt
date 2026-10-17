package dev.levo.levoprint

import android.net.Uri
import org.json.JSONObject

// Emparejamiento por codigo de 8 caracteres (tecleado o via QR), en vez de
// pegar URL/anon/device a mano. Contrato con el backend (RPC publica
// "<prefijo>_estacion_codigo_canjear", ver levoprint.sql seccion 3):
//   POST <url>/rest/v1/rpc/<prefijo>_estacion_codigo_canjear
//   body {"p":{"codigo":"XXXXXXXX"}}
//   -> { ok, url, anon, prefijo, device, ancho, nombre, modo?, reemplazara?, reintento? }
//   -> { ok:false, error: CODIGO_INVALIDO | CODIGO_VENCIDO | CODIGO_USADO |
//        AGENTE_YA_VINCULADO | IP_DESCONOCIDA | DEMASIADOS_INTENTOS (+ segundos) }
//
// [canje-v3] Contrato rev 3 del modulo levoprint:
//   · DEMASIADOS_INTENTOS trae "segundos" (espera real que calcula el freno
//     por IP o el tope global); se muestra tal cual al dueno.
//   · Exito: "modo" (nuevo|reemplazar|adicional) y "reemplazara" = cuantos
//     equipos anteriores se apagaran cuando ESTE se conecte por primera vez.
//     "reintento": true si es el recanje idempotente (misma IP, 3 min).
//   · El QR de la consola ya trae &p=<prefijo>: parseLink lo lee y canjear
//     va DIRECTO a ese proyecto (un solo intento). Importa porque cada
//     CODIGO_INVALIDO suma al freno por IP del proyecto: probar komo y luego
//     kipu "a ciegas" gastaria intentos en el proyecto equivocado.
//
// Resolucion del proyecto ANTES de llamar la RPC (el APK es GENERICO):
//   1) Link con &p=<prefijo> (y opcional &u=<url>&a=<anon>): se usa directo,
//      sin adivinar. Es el caso normal desde la rev 3 (QR de la consola).
//   2) Codigo tecleado a mano (sin pistas): se prueba contra cada "proyecto
//      conocido" (KOMO y KIPU comparten Supabase) hasta que uno responda
//      ok=true. Cualquier error distinto de CODIGO_INVALIDO corta la busqueda
//      (vencido/usado/freno/IP no dependen del prefijo).
sealed class CanjeResultado {
  data class Ok(
    val cfg: Cfg, val nombre: String,
    val modo: String = "", val reemplazara: Int = 0, val reintento: Boolean = false
  ) : CanjeResultado()
  data class Error(val codigo: String, val mensaje: String) : CanjeResultado()
}

data class DatosLink(val codigo: String, val prefijo: String?, val url: String?, val anon: String?)

object Emparejamiento {
  // Mensajes para el dueno (no tecnico). "segundos" solo aplica a
  // DEMASIADOS_INTENTOS (viene del servidor).
  fun mensajeError(err: String, segundos: Int = 0): String = when (err) {
    "CODIGO_INVALIDO" -> "El código no es válido. Revisa que esté bien escrito."
    "CODIGO_VENCIDO" -> "El código venció (dura 15 min). Genera uno nuevo en la consola (Estaciones)."
    "CODIGO_USADO" -> "Ese código ya se usó. Genera uno nuevo en la consola (Estaciones)."
    "DEMASIADOS_INTENTOS" -> "Hubo demasiados intentos con códigos equivocados. " + textoEspera(segundos)
    "AGENTE_YA_VINCULADO" -> "Este local ya tiene otro equipo de impresión vinculado. En la consola (Estaciones), genera un código nuevo y elige si este equipo reemplaza al anterior o se suma como adicional."
    "IP_DESCONOCIDA" -> "No pudimos verificar tu conexión. Revisa el internet (si usas VPN o proxy, apágalo) e intenta de nuevo."
    "AGENTE_INVALIDO" -> MSG_REEMPLAZADO
    "SIN_CODIGO" -> "Escribe el código de 8 caracteres."
    "RED" -> "No se pudo conectar. Revisa tu internet e intenta de nuevo."
    "RESPUESTA_INCOMPLETA" -> "El servidor respondió sin los datos necesarios. Intenta de nuevo."
    else -> "No se pudo emparejar ($err)."
  }

  const val MSG_REEMPLAZADO = "Este equipo fue reemplazado o desactivado; vincúlalo de nuevo con un código de la consola (Estaciones)."

  private fun textoEspera(seg: Int): String =
    if (seg > 0) "Espera $seg ${if (seg == 1) "segundo" else "segundos"} y vuelve a intentar."
    else "Espera un momento y vuelve a intentar."

  // Codigo normalizado igual que el servidor: mayusculas y sin espacios
  // (incluye saltos de linea CR/LF de un copiar/pegar).
  fun normalizar(codigo: String): String = codigo.uppercase().filter { !it.isWhitespace() }

  // "levoprint://emparejar?c=XXXXXXXX" (o el equivalente https, por si la
  // consola cambia el esquema del QR) -> DatosLink. null si no trae codigo.
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

    val candidatos: List<ProyectoLP> = when {
      // Deep-link trae url+anon+prefijo completos: un solo intento.
      urlForzada != null && anonForzado != null ->
        listOf(ProyectoLP(prefijoForzado ?: "komo", prefijoForzado ?: "komo", urlForzada, anonForzado))
      // Deep-link trae solo el prefijo (QR rev 3): UN solo candidato, el de ese
      // prefijo (o url/anon compartidos si es un proyecto que este build no conoce).
      prefijoForzado != null ->
        Proyectos.conocidos.filter { it.prefijo.equals(prefijoForzado, ignoreCase = true) }
          .ifEmpty { listOf(ProyectoLP(prefijoForzado, prefijoForzado, Proyectos.conocidos.first().url, Proyectos.conocidos.first().anon)) }
      // Codigo tecleado a mano, sin pistas: prueba todos los proyectos conocidos.
      else -> Proyectos.conocidos
    }

    var ultimoErr = "CODIGO_INVALIDO"
    var ultimoMsg = mensajeError("CODIGO_INVALIDO")
    for (p in candidatos) {
      try {
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
          if (cfg.device.isBlank()) return CanjeResultado.Error("RESPUESTA_INCOMPLETA", mensajeError("RESPUESTA_INCOMPLETA"))
          return CanjeResultado.Ok(
            cfg, r.optString("nombre").ifBlank { "Estación" },
            modo = r.optString("modo"),
            // rev 3 lo llama "reemplazara"; se acepta "reemplazados" por si el contrato cambia de nombre.
            reemplazara = r.optInt("reemplazara", r.optInt("reemplazados", 0)),
            reintento = r.optBoolean("reintento", false)
          )
        } else {
          val err = r.optString("error", "ERROR")
          ultimoErr = err
          ultimoMsg = mensajeError(err, r.optInt("segundos", 0))
          if (err != "CODIGO_INVALIDO") break // vencido/usado/freno/IP: no depende del prefijo, no sigas probando otros
        }
      } catch (e: Exception) {
        ultimoErr = "RED"
        ultimoMsg = mensajeError("RED")
      }
    }
    return CanjeResultado.Error(ultimoErr, ultimoMsg)
  }
}
