package dev.levo.levoprint

import android.content.Context

object Prefs {
  private const val F = "levoprint"

  fun guardar(ctx: Context, c: Cfg) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("url", c.url).putString("anon", c.anon).putString("device", c.device)
      .putString("prefijo", c.prefijo).putInt("ancho", c.ancho)
      .putBoolean("reemplazado", false).apply() // config nueva: deja atras el aviso de reemplazo
  }

  // [canje-v3] El servidor dijo AGENTE_INVALIDO (este equipo fue reemplazado
  // o desactivado). Se borra SOLO el token del dispositivo: url/anon/prefijo/
  // ancho y la impresora Bluetooth se conservan, para que el dueno vuelva a
  // emparejar con un codigo nuevo sin tocar nada mas. Sin device, leer()
  // devuelve null y ni el arranque automatico ni el BootReceiver reintentan
  // con el token muerto.
  fun desvincular(ctx: Context) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .remove("device").putBoolean("reemplazado", true).apply()
  }

  fun getReemplazado(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("reemplazado", false)

  fun leer(ctx: Context): Cfg? {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    val url = p.getString("url", "") ?: ""
    val anon = p.getString("anon", "") ?: ""
    val device = p.getString("device", "") ?: ""
    if (url.isBlank() || anon.isBlank() || device.isBlank()) return null
    return Cfg(url, anon, device, p.getString("prefijo", "komo") ?: "komo", p.getInt("ancho", 48))
  }

  // Para rellenar la pantalla aunque falte el device (tras desvincular):
  // url/anon/prefijo/ancho siguen guardados y se muestran.
  fun leerSinDevice(ctx: Context): Cfg {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    return Cfg(p.getString("url", "") ?: "", p.getString("anon", "") ?: "", p.getString("device", "") ?: "",
      p.getString("prefijo", "komo") ?: "komo", p.getInt("ancho", 48))
  }

  fun setBluetooth(ctx: Context, on: Boolean) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit().putBoolean("bt", on).apply()
  }

  fun getBluetooth(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("bt", false)

  fun setBt(ctx: Context, mac: String, nombre: String) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("btMac", mac).putString("btNombre", nombre).apply()
  }

  fun getBtMac(ctx: Context): String =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getString("btMac", "") ?: ""

  fun getBtNombre(ctx: Context): String =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getString("btNombre", "") ?: ""
}
