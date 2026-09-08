package dev.levo.levoprint

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.android.material.materialswitch.MaterialSwitch

class MainActivity : AppCompatActivity() {
  private val h = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    val inUrl = findViewById<EditText>(R.id.inUrl)
    val inAnon = findViewById<EditText>(R.id.inAnon)
    val inDevice = findViewById<EditText>(R.id.inDevice)
    val inPrefijo = findViewById<EditText>(R.id.inPrefijo)
    val inAncho = findViewById<EditText>(R.id.inAncho)
    val swBt = findViewById<MaterialSwitch>(R.id.swBluetooth)
    val btn = findViewById<Button>(R.id.btnToggle)
    val estado = findViewById<TextView>(R.id.txtEstado)
    val log = findViewById<TextView>(R.id.txtLog)

    Prefs.leer(this)?.let {
      inUrl.setText(it.url); inAnon.setText(it.anon); inDevice.setText(it.device)
      inPrefijo.setText(it.prefijo); inAncho.setText(it.ancho.toString())
    }
    swBt.isChecked = Prefs.getBluetooth(this)
    swBt.setOnCheckedChangeListener { _, on ->
      Prefs.setBluetooth(this, on)
      if (on && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) pedir(Manifest.permission.BLUETOOTH_CONNECT)
    }

    fun refrescar() {
      val on = PrintService.activo
      btn.text = if (on) "Detener" else "Guardar y arrancar"
      estado.text = if (on) "Activo · escuchando impresion" else "Detenido"
    }

    btn.setOnClickListener {
      if (PrintService.activo) {
        stopService(Intent(this, PrintService::class.java))
      } else {
        val ancho = inAncho.text.toString().toIntOrNull() ?: 48
        Prefs.guardar(this, Cfg(
          inUrl.text.toString().trim(), inAnon.text.toString().trim(),
          inDevice.text.toString().trim(),
          inPrefijo.text.toString().trim().ifBlank { "komo" }, ancho
        ))
        if (Prefs.leer(this) == null) { estado.text = "Faltan datos: URL, clave y device"; return@setOnClickListener }
        val i = Intent(this, PrintService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
      }
      h.postDelayed({ refrescar() }, 500)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pedir(Manifest.permission.POST_NOTIFICATIONS)

    refrescar()
    val tick = object : Runnable {
      override fun run() { log.text = PrintService.ultimoLog; refrescar(); h.postDelayed(this, 1500) }
    }
    h.post(tick)
  }

  private fun pedir(p: String) {
    if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED)
      ActivityCompat.requestPermissions(this, arrayOf(p), 1)
  }
}
