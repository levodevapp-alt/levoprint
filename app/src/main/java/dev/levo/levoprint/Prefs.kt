package dev.levo.levoprint

import android.content.Context

object Prefs {
  private const val F = "levoprint"

  // [LP-U1] Varias apps en un mismo LevoPrint: lista de vinculos en "vinculos" (JSON
  // [{url, anon, device, prefijo, nombre}]), uno por app (prefijo). Un codigo de OTRA app
  // agrega un vinculo; uno de la MISMA app reemplaza al de esa app. El ancho es uno solo
  // (es del papel de este equipo). Las claves sueltas de siempre (url/anon/device/prefijo)
  // guardan el PRIMER vinculo: las Opciones avanzadas lo muestran y, si alguien vuelve a
  // instalar un APK anterior, sigue imprimiendo al menos esa app.
  // Config vieja (solo las claves sueltas, sin "vinculos"): se migra la primera vez que se lee.
  fun guardar(ctx: Context, c: Cfg, nombre: String = "") {
    val lista = leerVinculosConNombre(ctx).toMutableList()
    val i = lista.indexOfFirst { it.first.prefijo.equals(c.prefijo, ignoreCase = true) }
    val previo = if (i >= 0) lista[i].second else ""
    val nuevo = c.copy(ancho = Agent.anchoValido(c.ancho)) to nombre.ifBlank { previo }
    if (i >= 0) lista[i] = nuevo else lista.add(nuevo)
    escribir(ctx, lista, Agent.anchoValido(c.ancho))
  }

  private fun escribir(ctx: Context, lista: List<Pair<Cfg, String>>, ancho: Int) {
    val arr = org.json.JSONArray()
    for ((c, nombre) in lista) arr.put(org.json.JSONObject()
      .put("url", c.url).put("anon", c.anon).put("device", c.device).put("prefijo", c.prefijo).put("nombre", nombre))
    val e = ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("vinculos", arr.toString()).putInt("ancho", ancho)
      .remove("reemplazado") // [qa4] marca de canje-v3 ya sin uso: se limpia
    lista.firstOrNull()?.first?.let { p ->
      e.putString("url", p.url).putString("anon", p.anon).putString("device", p.device).putString("prefijo", p.prefijo)
    }
    e.apply()
  }

  // Vinculos completos (con url, anon y device) + su nombre visible ("<estacion> · <negocio>").
  fun leerVinculosConNombre(ctx: Context): List<Pair<Cfg, String>> {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    val ancho = Agent.anchoValido(p.getInt("ancho", 48))
    val crudo = p.getString("vinculos", null)
    if (crudo == null) {
      // Migracion de la config de un solo vinculo (APK 1.5.0 o anterior).
      val url = p.getString("url", "") ?: ""
      val anon = p.getString("anon", "") ?: ""
      val device = p.getString("device", "") ?: ""
      if (url.isBlank() || anon.isBlank() || device.isBlank()) return emptyList()
      val viejo = listOf(Cfg(url, anon, device, p.getString("prefijo", "komo") ?: "komo", ancho) to "")
      escribir(ctx, viejo, ancho)
      return viejo
    }
    return try {
      val arr = org.json.JSONArray(crudo)
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.getJSONObject(i)
        val c = Cfg(o.optString("url"), o.optString("anon"), o.optString("device"), o.optString("prefijo").ifBlank { "komo" }, ancho)
        if (c.url.isBlank() || c.anon.isBlank() || c.device.isBlank()) null else c to o.optString("nombre")
      }
    } catch (_: Exception) { emptyList() }
  }

  fun leerVinculos(ctx: Context): List<Cfg> = leerVinculosConNombre(ctx).map { it.first }

  // Primer vinculo (o null si no hay ninguno): para "¿hay algo configurado?" (BootReceiver, pantalla).
  fun leer(ctx: Context): Cfg? = leerVinculos(ctx).firstOrNull()

  // Para rellenar la pantalla aunque falte algun dato (config a medias):
  // lo que este guardado se muestra igual.
  fun leerSinDevice(ctx: Context): Cfg {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    return Cfg(p.getString("url", "") ?: "", p.getString("anon", "") ?: "", p.getString("device", "") ?: "",
      p.getString("prefijo", "komo") ?: "komo", Agent.anchoValido(p.getInt("ancho", 48)))
  }

  fun setBluetooth(ctx: Context, on: Boolean) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit().putBoolean("bt", on).apply()
  }

  fun getBluetooth(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("bt", false)

  // [MM3-01 · MM3-P1] Pie del ticket con el logo (imagen GS v 0). Apagado: impresora vieja sin soporte de
  // imagen -> el pie sale solo en texto. Por defecto encendido.
  fun setImagen(ctx: Context, on: Boolean) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit().putBoolean("imagen", on).apply()
  }

  fun getImagen(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("imagen", true)

  fun setBt(ctx: Context, mac: String, nombre: String) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("btMac", mac).putString("btNombre", nombre).apply()
  }

  fun getBtMac(ctx: Context): String =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getString("btMac", "") ?: ""

  // [MM4-07 · QA BAJO-7] La tarjeta del ahorro de bateria ya se mostro alguna vez: al volver con el
  // permiso queda en verde aunque la app se haya cerrado entre medio (Ajustes puede matar el proceso).
  fun setBateriaPedida(ctx: Context, v: Boolean) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit().putBoolean("bateriaPedida", v).apply()
  }

  fun getBateriaPedida(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("bateriaPedida", false)

  fun getBtNombre(ctx: Context): String =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getString("btNombre", "") ?: ""
}
