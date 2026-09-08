package dev.levo.levoprint

import android.content.Context

object Prefs {
  private const val F = "levoprint"

  fun guardar(ctx: Context, c: Cfg) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit()
      .putString("url", c.url).putString("anon", c.anon).putString("device", c.device)
      .putString("prefijo", c.prefijo).putInt("ancho", c.ancho).apply()
  }

  fun leer(ctx: Context): Cfg? {
    val p = ctx.getSharedPreferences(F, Context.MODE_PRIVATE)
    val url = p.getString("url", "") ?: ""
    val anon = p.getString("anon", "") ?: ""
    val device = p.getString("device", "") ?: ""
    if (url.isBlank() || anon.isBlank() || device.isBlank()) return null
    return Cfg(url, anon, device, p.getString("prefijo", "komo") ?: "komo", p.getInt("ancho", 48))
  }

  fun setBluetooth(ctx: Context, on: Boolean) {
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).edit().putBoolean("bt", on).apply()
  }

  fun getBluetooth(ctx: Context): Boolean =
    ctx.getSharedPreferences(F, Context.MODE_PRIVATE).getBoolean("bt", false)
}
