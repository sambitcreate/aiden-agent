package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.auth.AidenSecureStore
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.models.AidenPairingTrust
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.io.File
import java.time.Instant

@Serializable
private data class InstallationsPersistenceModel(
    val installations: List<AidenInstallation>,
    val activeInstallationId: String?
)

class AidenInstallationStore(
    private val storageDir: File,
    val secureStore: AidenSecureStore
) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val storeFile = File(storageDir, "installations.json")

    private val _installations = MutableStateFlow<List<AidenInstallation>>(emptyList())
    val installations: StateFlow<List<AidenInstallation>> = _installations.asStateFlow()

    private val _activeInstallationId = MutableStateFlow<String?>(null)
    val activeInstallationId: StateFlow<String?> = _activeInstallationId.asStateFlow()

    val activeInstallation: AidenInstallation?
        get() = _activeInstallationId.value?.let { id -> _installations.value.firstOrNull { it.id == id } }

    init {
        load()
    }

    @Synchronized
    private fun load() {
        if (!storeFile.exists()) return
        try {
            val content = storeFile.readText(Charsets.UTF_8)
            val model = json.decodeFromString<InstallationsPersistenceModel>(content)
            _installations.value = model.installations
            _activeInstallationId.value = model.activeInstallationId ?: model.installations.firstOrNull()?.id
        } catch (_: Exception) {
            // Error loading, retain default empty
        }
    }

    @Synchronized
    private fun save() {
        try {
            storageDir.mkdirs()
            val model = InstallationsPersistenceModel(_installations.value, _activeInstallationId.value)
            val content = json.encodeToString(model)
            storeFile.writeText(content, Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    fun addInstallation(
        exchange: AidenPairingExchange,
        trust: AidenPairingTrust?
    ): AidenInstallation {
        val installation = AidenInstallation(
            instanceId = exchange.instanceId,
            deviceId = exchange.deviceId,
            name = exchange.displayName ?: "Aiden Mac",
            endpoint = exchange.endpoint,
            serverSpkiSha256 = exchange.serverSpkiSha256,
            pairingTrust = trust,
            credentialScope = AidenInstallation.makeCredentialScope(exchange.instanceId, exchange.deviceId),
            deviceCapabilities = exchange.capabilities,
            serverCapabilities = exchange.capabilities,
            createdAt = Instant.now(),
            lastConnectedAt = Instant.now()
        )

        secureStore.setCredential(installation.credentialScope, exchange.credential)

        val updated = _installations.value.filter { it.id != installation.id } + installation
        _installations.value = updated
        _activeInstallationId.value = installation.id
        save()
        return installation
    }

    fun setActiveInstallation(id: String?) {
        if (id == null || _installations.value.any { it.id == id }) {
            _activeInstallationId.value = id
            save()
        }
    }

    fun removeInstallation(id: String) {
        val target = _installations.value.firstOrNull { it.id == id } ?: return
        secureStore.removeCredential(target.credentialScope)
        _installations.value = _installations.value.filter { it.id != id }
        if (_activeInstallationId.value == id) {
            _activeInstallationId.value = _installations.value.firstOrNull()?.id
        }
        save()
    }

    fun updateServerCapabilities(
        instanceId: String,
        serverCapabilities: List<AidenRemoteCapability>,
        serverName: String?,
        deviceCapabilities: List<AidenRemoteCapability>
    ) {
        val list = _installations.value.toMutableList()
        val index = list.indexOfFirst { it.instanceId == instanceId }
        if (index != -1) {
            val item = list[index]
            // /server's capabilities is the device's exact grant list and may
            // narrow. Drops are narrowing-only here; grants are added solely by
            // the negotiation path below. Narrowing first keeps the stored
            // model's serverCapabilities superset invariant valid when the
            // server withdraws a grant.
            val refreshedDeviceGrants = deviceCapabilities.toSet()
            val updated = item.copy(
                deviceCapabilities = item.deviceCapabilities.filter { refreshedDeviceGrants.contains(it) },
                serverCapabilities = serverCapabilities,
                name = serverName ?: item.name,
                lastConnectedAt = Instant.now()
            )
            list[index] = updated
            _installations.value = list
            save()
        }
    }

    fun updateDeviceCapabilities(
        instanceId: String,
        deviceCapabilities: List<AidenRemoteCapability>
    ) {
        val list = _installations.value.toMutableList()
        val index = list.indexOfFirst { it.instanceId == instanceId }
        if (index == -1) return
        val item = list[index]
        // A non-null serverCapabilities list is authoritative. Do not persist
        // a grant until the server has advertised it after negotiation.
        if (item.serverCapabilities != null && !item.serverCapabilities!!.containsAll(deviceCapabilities)) return
        // The negotiation route can only add progress grants; a response that
        // drops or widens unrelated authority is contract-invalid. Reject it
        // instead of persisting different non-progress authority.
        val progress = setOf(AidenRemoteCapability.TASKS_READ, AidenRemoteCapability.AGENTS_READ)
        if (item.deviceCapabilities.toSet() - progress != deviceCapabilities.toSet() - progress) return
        list[index] = item.copy(deviceCapabilities = deviceCapabilities)
        _installations.value = list
        save()
    }

    fun getCredential(installation: AidenInstallation): String? {
        return secureStore.getCredential(installation.credentialScope)
    }
}
