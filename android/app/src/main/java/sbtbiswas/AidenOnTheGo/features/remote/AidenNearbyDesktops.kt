package sbtbiswas.AidenOnTheGo.features.remote

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext

internal data class NearbyDesktop(val name: String, val endpoint: String)

internal fun nearbyDesktopEndpoint(host: String?, port: Int): String? {
    if (host == null || port !in 1..65535) return null
    val hostname = host.lowercase().trimEnd('.')
    if (hostname.length > 253 || !hostname.endsWith(".local") ||
        !hostname.split('.').all { it.length in 1..63 && it.matches(Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")) }) return null
    return "https://$hostname:$port/api/aiden/v1"
}

/** Discovery provides addresses only; the setup code still establishes trust. */
@Composable
internal fun rememberNearbyDesktops(enabled: Boolean, refresh: Int): Pair<List<NearbyDesktop>, String?> {
    val context = LocalContext.current.applicationContext
    var desktops by remember { mutableStateOf(emptyList<NearbyDesktop>()) }
    var error by remember { mutableStateOf<String?>(null) }
    DisposableEffect(enabled, refresh) {
        if (!enabled) return@DisposableEffect onDispose { }
        desktops = emptyList()
        error = null
        val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        val main = Handler(Looper.getMainLooper())
        var active = true
        val services = linkedMapOf<String, NearbyDesktop>()
        val pending = ArrayDeque<NsdServiceInfo>()
        var resolving = false
        var resolvingName: String? = null
        val lost = mutableSetOf<String>()
        fun publish() { if (active) desktops = services.values.sortedBy { it.name.lowercase() } }
        fun resolveNext() {
            if (!active || resolving || pending.isEmpty()) return
            resolving = true
            val service = pending.removeFirst()
            resolvingName = service.serviceName
            try {
                @Suppress("DEPRECATION")
                manager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        main.post { lost.clear(); resolvingName = null; resolving = false; resolveNext() }
                    }
                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        main.post {
                            if (active && serviceInfo.serviceName !in lost) {
                                nearbyDesktopEndpoint(serviceInfo.attributes["hostname"]?.toString(Charsets.UTF_8), serviceInfo.port)?.let {
                                    services[serviceInfo.serviceName] = NearbyDesktop(serviceInfo.serviceName, it)
                                    publish()
                                } ?: run { error = "A nearby desktop needs manual setup. Scan its QR code or enter the address shown in its connection settings." }
                            }
                            lost.clear()
                            resolvingName = null
                            resolving = false
                            resolveNext()
                        }
                    }
                })
            } catch (_: SecurityException) {
                resolving = false
                resolvingName = null
                pending.clear()
                lost.clear()
                if (active) error = "Allow local-network access in Settings, or enter your desktop address."
            } catch (_: IllegalArgumentException) {
                resolving = false
                resolvingName = null
                pending.clear()
                lost.clear()
                if (active) error = "Nearby discovery is unavailable. Enter your desktop address or try again."
            }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { if (active) error = "Nearby discovery is unavailable. Check local-network access in Settings, or enter your desktop address." }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                main.post {
                    if (active && services.size + pending.size < 32) {
                        lost.remove(serviceInfo.serviceName)
                        pending.addLast(serviceInfo)
                        resolveNext()
                    }
                }
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                main.post {
                    if (active) {
                        if (resolvingName == serviceInfo.serviceName) lost.add(serviceInfo.serviceName)
                        pending.removeAll { it.serviceName == serviceInfo.serviceName }
                        services.remove(serviceInfo.serviceName)
                        publish()
                    }
                }
            }
        }
        try { manager.discoverServices("_aiden-agent._tcp.", NsdManager.PROTOCOL_DNS_SD, listener) }
        catch (_: SecurityException) { error = "Allow local-network access in Settings, or enter your desktop address." }
        catch (_: IllegalArgumentException) { error = "Nearby discovery could not start. Enter your desktop address or try again." }
        onDispose {
            active = false
            pending.clear()
            try { manager.stopServiceDiscovery(listener) } catch (_: IllegalArgumentException) { } catch (_: SecurityException) { }
        }
    }
    return desktops to error
}
