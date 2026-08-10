package co.logos.delivery.client

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Base64
import co.logos.delivery.ILogosDelivery
import co.logos.delivery.ILogosDeliveryCallback
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

// Client side of the shared delivery service. Binds co.logos.delivery's AIDL service and
// routes subscribe/send/receive through it, so this app uses the ONE device-wide node
// instead of embedding its own. Received messages are re-emitted as a JS event.
class LogosDeliveryClientModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "LogosDeliveryClient"
  private var svc: ILogosDelivery? = null
  private var appId: String = "app"
  private var pending: Promise? = null

  private val callback = object : ILogosDeliveryCallback.Stub() {
    override fun onMessage(topic: String, candidatesJson: String) {
      val p = Arguments.createMap().apply { putString("topic", topic); putString("candidatesJson", candidatesJson) }
      try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("logosDeliveryMessage", p) } catch (_: Throwable) {}
    }
  }
  private val conn = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) { svc = ILogosDelivery.Stub.asInterface(binder); pending?.resolve(true); pending = null }
    override fun onServiceDisconnected(name: ComponentName?) { svc = null }
  }

  @ReactMethod fun connect(promise: Promise) {
    if (svc != null) { promise.resolve(true); return }
    pending = promise
    val intent = Intent().apply { component = ComponentName("co.logos.delivery", "co.logos.delivery.svc.LogosDeliveryService") }
    val ok = try { ctx.bindService(intent, conn, Context.BIND_AUTO_CREATE) } catch (_: Throwable) { false }
    if (!ok) { pending = null; promise.resolve(false) }
  }
  @ReactMethod fun register(id: String) { appId = id; try { svc?.registerClient(id, callback) } catch (_: Throwable) {} }
  @ReactMethod fun subscribe(topic: String) { try { svc?.subscribe(appId, topic) } catch (_: Throwable) {} }
  @ReactMethod fun send(topic: String, sealedB64: String) { try { svc?.send(appId, topic, Base64.decode(sealedB64, Base64.NO_WRAP)) } catch (_: Throwable) {} }
  @ReactMethod fun disconnect() { try { svc?.unregisterClient(appId); ctx.unbindService(conn) } catch (_: Throwable) {}; svc = null }
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
