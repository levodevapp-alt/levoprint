package dev.levo.levoprint

import android.content.Context

object Prefs {
  private const val F = "levoprint"

  fun guardar(ctx: Context, c: Cfg) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("url", c.url).putString("anon", c.anon).putString("device", c.device)
      .putString("prefijo", c.prefijo).putInt("ancho", Agent.anchoValido(c.ancho))
      .remove("reemplazado") // [qa4] marca de canje-v3 ya sin uso: se limpia
      .apply()
  }

  fun leer(ctx: Context): Cfg? {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    val url = p.getString("url", "") ?: ""
    val anon = p.getString("anon", "") ?: ""
    val device = p.getString("device", "") ?: ""
    if (url.isBlank() || anon.isBlank() || device.isBlank()) return null
    return Cfg(url, anon, device, p.getString("prefijo", "komo") ?: "komo", Agent.anchoValido(p.getInt("ancho", 48)))
  }

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
