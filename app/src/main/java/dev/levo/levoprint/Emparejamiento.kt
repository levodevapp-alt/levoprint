package dev.levo.levoprint

import android.net.Uri
import org.json.JSONObject

// Emparejamiento por codigo de 8 caracteres (tecleado o via QR), en vez de
// pegar URL/anon/device a mano. Contrato con el backend (RPC publica
// "<prefijo>_estacion_codigo_canjear", ver levoprint.sql seccion 3):
//   POST <url>/rest/v1/rpc/<prefijo>_estacion_codigo_canjear
//   body {"p":{"codigo":"XXXXXXXX"}}
//   -> { ok, url, anon, prefijo, device, ancho, nombre }
//   -> { ok:false, error: CODIGO_INVALIDO | CODIGO_VENCIDO | CODIGO_USADO }
//
// El QR de la consola hoy es "levoprint://emparejar?c=XXXXXXXX" (SOLO el
// codigo). Como el APK es GENERICO (sirve para KOMO, KIPU, etc.), necesita
// saber que prefijo/url/anon usar ANTES de poder llamar la RPC. Se resuelve
// asi:
//   1) Si el link ya trae &p=<prefijo>&u=<url>&a=<anon> (recomendado a
//      futuro: pedirle a consola/backend que los agregue al armar el QR en
//      __PREFIX___estacion_codigo_crear), se usan directo, sin adivinar.
//      NO se aplico ese cambio de backend desde aca — queda pendiente de
//      coordinar con consola.
//   2) Si no, se prueba el codigo contra cada "proyecto conocido" (hoy KOMO
//      y KIPU comparten el mismo Supabase, asi que en la practica esto
//      SIEMPRE funciona sin pedirle nada al usuario) hasta que uno responda
//      ok=true. CODIGO_VENCIDO/CODIGO_USADO no dependen del prefijo asi que
//      ahi se corta la busqueda; CODIGO_INVALIDO sigue probando el resto.
sealed class CanjeResultado {
  data class Ok(val cfg: Cfg, val nombre: String) : CanjeResultado()
  data class Error(val codigo: String, val mensaje: String) : CanjeResultado()
}

data class DatosLink(val codigo: String, val prefijo: String?, val url: String?, val anon: String?)

object Emparejamiento {
  fun mensajeError(err: String): String = when (err) {
    "CODIGO_INVALIDO" -> "El código no es válido. Revisa que esté bien escrito."
    "CODIGO_VENCIDO" -> "El código venció (dura 15 min). Genera uno nuevo en la consola (Estaciones)."
    "CODIGO_USADO" -> "Ese código ya se usó. Genera uno nuevo en la consola (Estaciones)."
    "SIN_CODIGO" -> "Escribe el código de 8 caracteres."
    "RED" -> "No se pudo conectar. Revisa tu internet e intenta de nuevo."
    "RESPUESTA_INCOMPLETA" -> "El servidor respondió sin los datos necesarios. Intenta de nuevo."
    else -> "No se pudo emparejar ($err)."
  }

  // "levoprint://emparejar?c=XXXXXXXX" (o el equivalente https, por si la
  // consola cambia el esquema del QR) -> DatosLink. null si no trae codigo.
  fun parseLink(uri: Uri): DatosLink? {
    val c = uri.getQueryParameter("c")?.trim()?.uppercase()
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
    val cod = codigoIn.trim().uppercase()
    if (cod.isBlank()) return CanjeResultado.Error("SIN_CODIGO", mensajeError("SIN_CODIGO"))

    val candidatos: List<ProyectoLP> = when {
      // Deep-link ya trae url+anon+prefijo completos (futuro, coordinar backend): un solo intento.
      urlForzada != null && anonForzado != null ->
        listOf(ProyectoLP(prefijoForzado ?: "komo", prefijoForzado ?: "komo", urlForzada, anonForzado))
      // Deep-link trae solo el prefijo: usa ese prefijo con el proyecto conocido (o url/anon compartidos si es uno nuevo).
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
          return CanjeResultado.Ok(cfg, r.optString("nombre").ifBlank { "Estación" })
        } else {
          val err = r.optString("error", "ERROR")
          ultimoErr = err
          ultimoMsg = mensajeError(err)
          if (err != "CODIGO_INVALIDO") break // vencido/usado: no depende del prefijo, no sigas probando otros
        }
      } catch (e: Exception) {
        ultimoErr = "RED"
        ultimoMsg = "No se pudo conectar: " + (e.message ?: "error de red")
      }
    }
    return CanjeResultado.Error(ultimoErr, ultimoMsg)
  }
}
