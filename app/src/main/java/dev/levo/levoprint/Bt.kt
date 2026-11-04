package dev.levo.levoprint

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.UUID

// Impresora Bluetooth (SPP clasico). [LP-F3] Ya no es solo «una impresora BT general»: cada estacion
// puede tener su impresora Bluetooth (transporte "bluetooth", btMac) y este equipo la busca:
//   · emparejadas: las que Android ya conoce.
//   · descubrimiento de 12 s (solo desde la pantalla: gasta bateria): equipos de imagen (impresoras,
//     clase 0x0600) o sin categoria (muchas termicas chinas no la declaran).
//   · emparejar: createBond; Android pide el PIN (casi siempre 0000 o 1234).
// Permisos: BLUETOOTH_CONNECT y BLUETOOTH_SCAN (neverForLocation) desde Android 12; antes, ubicacion
// para descubrir. Sin permiso, la lista sale vacia (no se cae).
object Bt {
  private val SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  private const val CLASE_IMAGEN = 0x0600
  private const val CLASE_SIN_CATEGORIA = 0x1F00

  data class Disp(val nombre: String, val mac: String, val emparejada: Boolean = true, val probableImpresora: Boolean = false)

  private fun adaptador(): BluetoothAdapter? = try { BluetoothAdapter.getDefaultAdapter() } catch (_: Exception) { null }

  private fun clase(d: BluetoothDevice): Int? = try { d.bluetoothClass?.majorDeviceClass } catch (_: SecurityException) { null }

  private fun nombre(d: BluetoothDevice): String = try { d.name ?: d.address } catch (_: SecurityException) { d.address }

  private fun esImpresoraPosible(d: BluetoothDevice): Boolean {
    val c = clase(d)
    return c == null || c == CLASE_IMAGEN || c == CLASE_SIN_CATEGORIA || c == BluetoothClass.Device.Major.UNCATEGORIZED
  }

  fun emparejadas(): List<Disp> {
    val a = adaptador() ?: return emptyList()
    return try {
      a.bondedDevices?.map { Disp(nombre(it), it.address.uppercase(), true, clase(it) == CLASE_IMAGEN) } ?: emptyList()
    } catch (e: SecurityException) {
      emptyList()
    }
  }

  // Descubre equipos cercanos durante `ms` (bloquea el hilo que llama: nunca el de la pantalla).
  // Devuelve solo los posibles (impresora o sin categoria), sin los ya emparejados.
  fun descubrir(ctx: Context, ms: Long = 12000L): List<Disp> {
    val a = adaptador() ?: return emptyList()
    val vistos = java.util.concurrent.ConcurrentHashMap<String, Disp>()
    val fin = java.util.concurrent.CountDownLatch(1)
    val receptor = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, i: Intent?) {
        if (i == null) return
        when (i.action) {
          BluetoothDevice.ACTION_FOUND -> {
            val d: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
              else @Suppress("DEPRECATION") i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            if (d != null && esImpresoraPosible(d)) {
              val emp = try { d.bondState == BluetoothDevice.BOND_BONDED } catch (_: SecurityException) { false }
              if (!emp) vistos[d.address.uppercase()] = Disp(nombre(d), d.address.uppercase(), false, clase(d) == CLASE_IMAGEN)
            }
          }
          BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> fin.countDown()
        }
      }
    }
    val filtro = IntentFilter().apply { addAction(BluetoothDevice.ACTION_FOUND); addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED) }
    try {
      ContextCompat.registerReceiver(ctx, receptor, filtro, ContextCompat.RECEIVER_EXPORTED)
    } catch (_: Exception) { return emptyList() }
    try {
      if (!a.startDiscovery()) return emptyList()
      fin.await(ms, java.util.concurrent.TimeUnit.MILLISECONDS)
    } catch (_: SecurityException) {
    } catch (_: InterruptedException) {
    } finally {
      try { a.cancelDiscovery() } catch (_: SecurityException) {}
      try { ctx.unregisterReceiver(receptor) } catch (_: Exception) {}
    }
    return vistos.values.sortedBy { it.nombre }
  }

  // Empareja (createBond) y espera hasta 40 s a que quede. Android muestra el pedido de PIN.
  fun emparejar(mac: String): Boolean {
    val a = adaptador() ?: return false
    return try {
      val d = a.getRemoteDevice(mac)
      if (d.bondState == BluetoothDevice.BOND_BONDED) return true
      try { a.cancelDiscovery() } catch (_: SecurityException) {}
      if (!d.createBond()) return false
      val limite = System.currentTimeMillis() + 40000L
      while (System.currentTimeMillis() < limite) {
        Thread.sleep(500)
        when (d.bondState) {
          BluetoothDevice.BOND_BONDED -> return true
          BluetoothDevice.BOND_NONE -> return false
        }
      }
      false
    } catch (_: Exception) { false }
  }

  fun estaEmparejada(mac: String): Boolean = emparejadas().any { it.mac.equals(mac, ignoreCase = true) }

  fun imprimir(mac: String, texto: String) {
    val a = BluetoothAdapter.getDefaultAdapter() ?: throw RuntimeException("sin Bluetooth")
    val dev = a.getRemoteDevice(mac)
    val sock = dev.createRfcommSocketToServiceRecord(SPP)
    try {
      try { a.cancelDiscovery() } catch (_: SecurityException) {}
      sock.connect()
      sock.outputStream.use { it.write(Agent.bytes(texto)); it.flush(); try { Thread.sleep(900) } catch (_: InterruptedException) {} }
    } finally {
      try { sock.close() } catch (_: Exception) {}
    }
  }
}
