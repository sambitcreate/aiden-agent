package sbtbiswas.AidenOnTheGo.features.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionStore
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.intents.AidenIntentInstallationRecord
import sbtbiswas.AidenOnTheGo.intents.AidenIntentWorkspaceRecord
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenModelPreferenceStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotKeys
import sbtbiswas.AidenOnTheGo.persistence.AidenScheduledTaskCache
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceArchiveStore
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.OkHttpClient
import java.io.File
import java.util.UUID

data class AidenConnectionIssue(val title: String, val message: String, val canRetry: Boolean) {
    companion object {
        fun classify(error: Throwable): AidenConnectionIssue = when (error) {
            is javax.net.ssl.SSLException, AidenRemoteClientException.MissingTrustConfiguration ->
                AidenConnectionIssue("Verify this computer", "The computer's secure identity could not be verified. Check it on the desktop and pair again if its identity changed.", false)
            AidenRemoteClientException.MissingCredential ->
                AidenConnectionIssue("Pairing required", "Open Connections on the computer and pair this device again.", false)
            is sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException ->
                AidenConnectionIssue("Update required", "The computer returned data this app cannot use. Update Aiden on both devices, then retry.", true)
            is java.net.SocketTimeoutException ->
                AidenConnectionIssue("Computer did not answer", "Check that Aiden is running on the computer and try again.", true)
            is java.net.UnknownHostException, is java.net.NoRouteToHostException ->
                AidenConnectionIssue("Check the network", "Check Wi-Fi or cellular data and Tailscale if you use it. Saved conversations remain available.", true)
            else -> AidenConnectionIssue("Computer unavailable", "Check that Aiden is running and both devices can reach the same network or Tailscale, then retry.", true)
        }
    }
}
/**
 * The opt-in grants this phone asks a Mac for, each only from a Mac that announces its
 * feature, in this order. Older Macs never announce the newer features, so they never see the
 * phone-scoped subsets requested.
 */
private val AIDEN_PROGRESS_GRANTS: List<Pair<(AidenServer) -> Boolean, List<AidenRemoteCapability>>> = listOf(
    // Contract revision 32: native conversation app control panels.
    AidenServer::supportsChatUiPanels to listOf(AidenRemoteCapability.APP_CONTROLS_READ, AidenRemoteCapability.APP_CONTROLS_RESPOND),
    AidenServer::supportsChatTasks to listOf(AidenRemoteCapability.TASKS_READ),
    AidenServer::supportsChatAgents to listOf(AidenRemoteCapability.AGENTS_READ),
    AidenServer::supportsQuestionPrompts to listOf(AidenRemoteCapability.QUESTIONS_RESPOND),
    AidenServer::supportsChatSkills to listOf(AidenRemoteCapability.SKILLS_INVOKE),
    // Contract revision 24: the phone-scoped run subset.
    AidenServer::supportsPhoneRunControl to AidenRemoteCapability.PHONE_RUNS,
    // Contract revision 26: the phone simulator grant.
    AidenServer::supportsMobileSimulators to AidenRemoteCapability.PHONE_SIMULATORS,
    // Contract revision 27: memory and routine proposal cards.
    AidenServer::offersBotCards to AidenRemoteCapability.PHONE_BOT_CARDS,
    // Contract revision 30: activity frames and Chat activity.
    AidenServer::offersBotActivity to AidenRemoteCapability.PHONE_BOT_ACTIVITY
)

/**
 * What to ask [server] for: each grant whose feature the Mac announces and that [installation]
 * doesn't already hold. A grant left over from an older pairing is never asked for, or trusted,
 * without its feature.
 */
internal fun aidenProgressCapabilitiesToRequest(
    server: AidenServer,
    installation: AidenInstallation
): List<AidenRemoteCapability> =
    AIDEN_PROGRESS_GRANTS
        .filter { (announced, _) -> announced(server) }
        .flatMap { (_, grants) -> grants }
        .filterNot { installation.hasNegotiatedAccess(it) }
        .distinct()

/**
 * One pairing: the Mac, this phone's device id there, and when it was made. Unpairing and
 * pairing the same Mac again is another pairing, so nothing started for the old one lands in
 * the new one.
 */
data class AidenPairingIdentity(val instanceId: String, val deviceId: String, val pairedAt: java.time.Instant)

val AidenInstallation.pairing: AidenPairingIdentity
    get() = AidenPairingIdentity(instanceId, deviceId, createdAt)

enum class AidenConnectionState {
    NEEDS_PAIRING,
    CONNECTING,
    CONNECTED,
    OFFLINE
}

class AidenRemoteCoordinator(
    val installationStore: AidenInstallationStore,
    storageDir: File,
    private val chatCache: AidenChatCache = AidenChatCache(storageDir),
    private val draftStore: AidenChatDraftStore = AidenChatDraftStore(storageDir),
    private val navigationStore: AidenProductNavigationStore = AidenProductNavigationStore(storageDir),
    private val intentCatalogStore: AidenIntentCatalogStore? = null,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + Job()),
    /** Where unsent Bot messages wait on disk; the app passes `noBackupFilesDir` so they never reach a backup. */
    botOutboxDir: File = storageDir,
    /** Runs the Bot outbox's disk work in order; null uses its own thread. Tests hold it to order a read against a switch. */
    botOutboxIo: java.util.concurrent.Executor? = null
) {
    val archiveStore = AidenWorkspaceArchiveStore(storageDir)
    val workspaceCache = AidenWorkspaceEnvironmentCache(File(storageDir, "workspace_cache"))
    val scheduledCache = AidenScheduledTaskCache(File(storageDir, "scheduled_tasks_cache"))
    val usageCache = AidenUsageCache(File(storageDir, "usage_cache"))
    val botCache = AidenBotCache(storageDir)
    /** Bot chats' last transcripts and unsent messages (R14, R17), purged with the pairing. */
    val botSessionStore = File(botOutboxDir, "BotOutbox-v1").let { dir ->
        botOutboxIo?.let { AidenBotSessionStore(dir, io = it) } ?: AidenBotSessionStore(dir)
    }
    val modelPreferenceStore = AidenModelPreferenceStore(storageDir)
    val readSnapshotCache = AidenReadSnapshotCache(File(storageDir, "read_snapshots"))
    private val workspaceListSerializer = ListSerializer(AidenWorkspace.serializer())

    private val _connectionState = MutableStateFlow(
        if (installationStore.activeInstallation == null) {
            AidenConnectionState.NEEDS_PAIRING
        } else {
            AidenConnectionState.CONNECTING
        }
    )
    val connectionState: StateFlow<AidenConnectionState> = _connectionState.asStateFlow()
    private val _connectionIssue = MutableStateFlow<AidenConnectionIssue?>(null)
    val connectionIssue: StateFlow<AidenConnectionIssue?> = _connectionIssue.asStateFlow()

    private val _serverInfo = MutableStateFlow<AidenServer?>(null)
    val serverInfo: StateFlow<AidenServer?> = _serverInfo.asStateFlow()

    private val _client = MutableStateFlow<AidenRemoteClient?>(null)
    val client: StateFlow<AidenRemoteClient?> = _client.asStateFlow()
    /** The client [refreshClient] last made, with the pairing it was made for. */
    @Volatile
    private var clientOwner: Pair<AidenPairingIdentity, AidenRemoteClient>? = null

    private val _workspaces = MutableStateFlow<List<AidenWorkspace>>(emptyList())
    val workspaces: StateFlow<List<AidenWorkspace>> = _workspaces.asStateFlow()

    private val _hasCompletedWorkspaceRefresh = MutableStateFlow(false)
    val hasCompletedWorkspaceRefresh: StateFlow<Boolean> = _hasCompletedWorkspaceRefresh.asStateFlow()

    private val _isMutating = MutableStateFlow(false)
    val isMutating: StateFlow<Boolean> = _isMutating.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()
    private var activationGeneration: Long = 0
    private var pinnedHttp: Pair<PinnedHttpKey, OkHttpClient>? = null

    private data class PinnedHttpKey(val serverSpkiSha256: String, val trust: AidenPairingTrust?)

    /**
     * One OkHttp client per pinned trust anchor. Retrying or re-activating the
     * same installation reuses its connection pool, dispatcher threads, and TLS
     * sessions instead of building a fresh client each time.
     */
    private fun pinnedHttpClient(installation: AidenInstallation): OkHttpClient {
        val key = PinnedHttpKey(installation.serverSpkiSha256, installation.pairingTrust)
        pinnedHttp?.let { (cachedKey, cached) -> if (cachedKey == key) return cached }
        return AidenRemoteClient.createOkHttpClient(key.serverSpkiSha256, key.trust)
            .also { pinnedHttp = key to it }
    }

    val activeInstanceId: String?
        get() = installationStore.activeInstallation?.instanceId

    /** The pairing in use now, or null with none. */
    val activePairing: AidenPairingIdentity?
        get() = installationStore.activeInstallation?.pairing

    /** True while [pairing] is still the pairing in use. */
    fun holdsPairing(pairing: AidenPairingIdentity?): Boolean = pairing != null && activePairing == pairing

    /**
     * The client while it was made for [pairing] and [pairing] is still in use, or null. Right
     * after a switch the pairing in use changes before its client does; this never hands one
     * pairing's work the other pairing's client.
     */
    fun pairedClient(pairing: AidenPairingIdentity?): AidenRemoteClient? {
        val (owner, made) = clientOwner ?: return null
        return made.takeIf { owner == pairing && holdsPairing(pairing) && _client.value === made }
    }

    /**
     * Writes a Bot detail to the cache only while the pairing that was active when this was
     * made still is, so a save that finishes after an unpair or a re-pair never lands in
     * another pairing's cache.
     */
    fun pinnedBotCache(): (AidenBotDetail) -> Unit {
        val pairing = activePairing
        return { detail -> if (holdsPairing(pairing)) botCache.putBotDetail(detail) }
    }

    /**
     * Shows a Bot detail the Mac hasn't confirmed (an edit on its way, or a rollback) on every
     * screen without writing it to disk, pinned to the pairing like [pinnedBotCache].
     */
    fun pinnedBotShow(): (AidenBotDetail) -> Unit {
        val pairing = activePairing
        return { detail -> if (holdsPairing(pairing)) botCache.showBotDetail(detail) }
    }

    /**
     * Runs [block] on the coordinator's own scope, which outlives every screen. For work a
     * person started and may leave behind: a settings pick still saving after they back out.
     */
    fun launchDetached(block: suspend () -> Unit): Job {
        val entry = DetachedWork(activePairing)
        val job = scope.launch { block() }
        entry.job = job
        detachedWork += entry
        job.invokeOnCompletion { detachedWork.remove(entry) }
        return job
    }

    private class DetachedWork(val pairing: AidenPairingIdentity?) {
        lateinit var job: Job
    }

    private val detachedWork = java.util.concurrent.CopyOnWriteArrayList<DetachedWork>()

    /** Work started for one pairing doesn't run on for another, or for none. */
    private fun cancelDetachedWork(keep: (AidenPairingIdentity?) -> Boolean) {
        detachedWork.filterNot { keep(it.pairing) }.forEach { it.job.cancel() }
    }

    private val pairingMemos = mutableMapOf<Pair<AidenPairingIdentity?, String>, Any>()

    /** One [create]d object per pairing and [key], for state that must be shared across screens. */
    @Suppress("UNCHECKED_CAST")
    fun <T : Any> pairingMemo(key: String, create: () -> T): T =
        pairingMemos.getOrPut(activePairing to key) { create() } as T

    /**
     * Whether the active pairing's Mac last announced `bot-activity-v1` and this phone holds
     * `bot:activity` (R21: the feature and the grant, both persisted). It stands in until
     * `/server` answers, so an offline open keeps the line, Steer and Queue, and Chat activity.
     */
    val cachedBotActivitySupported: Boolean
        get() = installationStore.activeInstallation?.cachedBotActivitySupported == true

    /**
     * True while [client] is still the active client of installation [instanceId]. A read
     * started before a pairing was removed, revoked, or switched must check this right before
     * it publishes or caches its response, so it can never recreate a purged cache.
     */
    fun holdsReadAuthority(client: AidenRemoteClient?, instanceId: String?): Boolean =
        client != null && instanceId != null && _client.value === client && activeInstanceId == instanceId

    /** Stores [value] in the read-snapshot cache only if the request still holds read authority. */
    fun <T> storeReadSnapshotIfCurrent(
        client: AidenRemoteClient?,
        instanceId: String?,
        key: String,
        value: T,
        serializer: kotlinx.serialization.KSerializer<T>
    ): Boolean {
        if (!holdsReadAuthority(client, instanceId)) return false
        readSnapshotCache.store(instanceId!!, key, value, serializer)
        return true
    }

    fun presentError(message: String) {
        _errorMessage.value = message
    }

    fun clearError() {
        _errorMessage.value = null
    }

    init {
        scope.launch {
            installationStore.activeInstallationId.collect {
                refreshClient()
                refreshIntentCatalog()
            }
        }
    }

    fun refreshClient() {
        activationGeneration += 1
        val generation = activationGeneration
        val installation = installationStore.activeInstallation
        cancelDetachedWork { it != null && it == installation?.pairing }
        if (installation == null) {
            clientOwner = null
            _client.value = null
            _serverInfo.value = null
            _workspaces.value = emptyList()
            _hasCompletedWorkspaceRefresh.value = false
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val credential = installationStore.getCredential(installation)
        if (credential == null) {
            clientOwner = null
            _client.value = null
            _serverInfo.value = null
            _workspaces.value = emptyList()
            _hasCompletedWorkspaceRefresh.value = false
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val newClient = AidenRemoteClient(installation, credential, pinnedHttpClient(installation))
        botCache.activate(installation.instanceId, installation.deviceId)
        clientOwner = installation.pairing to newClient
        _client.value = newClient
        _serverInfo.value = null
        // The last Workspace list renders at once while the desktop is reached.
        _workspaces.value = cachedWorkspaces(installation.instanceId)
        _hasCompletedWorkspaceRefresh.value = false
        _connectionIssue.value = null
        _connectionState.value = AidenConnectionState.CONNECTING

        scope.launch {
            try {
                val server = newClient.server()
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                _connectionState.value = AidenConnectionState.CONNECTED
                val serverCapabilities = server.serverCapabilities ?: server.capabilities
                if (!serverCapabilities.contains(AidenRemoteCapability.SCHEDULE_READ)) {
                    scheduledCache.purge(installation.instanceId)
                }
                installationStore.updateServerCapabilities(
                    instanceId = installation.instanceId,
                    serverCapabilities = serverCapabilities,
                    serverName = server.name,
                    deviceCapabilities = server.capabilities,
                    serverFeatures = server.features
                )
                val negotiatedServer = negotiateProgressCapabilities(
                    generation = generation,
                    installation = installation,
                    client = newClient,
                    server = server
                )
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                installationStore.updateServerCapabilities(
                    instanceId = installation.instanceId,
                    serverCapabilities = negotiatedServer.serverCapabilities ?: negotiatedServer.capabilities,
                    serverName = negotiatedServer.name,
                    deviceCapabilities = negotiatedServer.capabilities,
                    serverFeatures = negotiatedServer.features
                )
                // Persist the negotiated grant before publishing serverInfo;
                // progress consumers use both values as one capability gate.
                _serverInfo.value = negotiatedServer
                refreshWorkspaces(generation)
            } catch (e: AidenRemoteClientException.Server) {
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                if (e.isCredentialRevoked) {
                    removeInstallation(installation.id)
                    _connectionState.value = AidenConnectionState.NEEDS_PAIRING
                } else {
                    _connectionIssue.value = AidenConnectionIssue.classify(e)
                    _connectionState.value = AidenConnectionState.OFFLINE
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                _connectionIssue.value = AidenConnectionIssue.classify(e)
                _connectionState.value = AidenConnectionState.OFFLINE
            }
        }
    }

    /**
     * Existing pairings may opt into progress only after /server advertises the
     * corresponding feature. A failed or legacy negotiation leaves the pairing
     * usable with the existing chat surface.
     */
    private suspend fun negotiateProgressCapabilities(
        generation: Long,
        installation: AidenInstallation,
        client: AidenRemoteClient,
        server: AidenServer
    ): AidenServer {
        if (!isCurrent(generation, installation.id, client)) return server
        val requested = aidenProgressCapabilitiesToRequest(server, installation)
        if (requested.isEmpty()) return server
        return try {
            val completeCapabilities = client.updateDeviceCapabilities(requested)
            if (!isCurrent(generation, installation.id, client)) return server
            val refreshed = client.server()
            if (!isCurrent(generation, installation.id, client)) return server
            // The legacy aggregate can keep Bot/chat clients working, but it
            // is not proof that the new progress grant was accepted. Require
            // the explicit server capability projection before persisting the
            // device grant used by the progress UI.
            val refreshedServerCapabilities = refreshed.serverCapabilities
            if (refreshedServerCapabilities == null || !refreshedServerCapabilities.containsAll(completeCapabilities)) {
                return refreshed
            }
            installationStore.updateServerCapabilities(
                instanceId = installation.instanceId,
                serverCapabilities = refreshedServerCapabilities,
                serverName = refreshed.name,
                deviceCapabilities = refreshed.capabilities,
                serverFeatures = refreshed.features
            )
            installationStore.updateDeviceCapabilities(installation.instanceId, completeCapabilities)
            refreshed
        } catch (error: CancellationException) {
            throw error
        } catch (error: AidenRemoteClientException.Server) {
            // Capability denial is a normal legacy/policy outcome. Only an
            // explicit revocation response should invalidate this pairing.
            if (error.statusCode == 401 ||
                error.body.code == sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode.CREDENTIAL_REVOKED
            ) throw error
            server
        } catch (_: Exception) {
            server
        }
    }

    fun refreshWorkspaces(expectedGeneration: Long = activationGeneration) {
        val currentClient = _client.value ?: return
        val instanceId = activeInstanceId
        val installationId = installationStore.activeInstallation?.id ?: return
        scope.launch {
            try {
                val list = currentClient.workspaces()
                if (!isCurrent(expectedGeneration, installationId, currentClient)) return@launch
                _workspaces.value = list
                if (instanceId != null) {
                    archiveStore.prune(instanceId, list.map { it.id }.toSet())
                    readSnapshotCache.store(instanceId, AidenReadSnapshotKeys.WORKSPACES, list, workspaceListSerializer)
                }
                refreshIntentCatalog()
            } catch (_: Exception) {
            } finally {
                if (isCurrent(expectedGeneration, installationId, currentClient)) {
                    _hasCompletedWorkspaceRefresh.value = true
                }
            }
        }
    }

    /**
     * Removes one pairing and every installation-scoped local artifact in one place.
     * Both user-initiated removal and server credential revocation must use this path.
     */
    fun removeInstallation(id: String) {
        val installation = installationStore.installations.value.firstOrNull { it.id == id } ?: return
        val wasActive = installation.id == installationStore.activeInstallationId.value
        val knownWorkspaceIds = buildSet {
            if (wasActive) addAll(_workspaces.value.map { it.id })
            addAll(
                intentCatalogStore
                    ?.load()
                    ?.workspaces
                    ?.filter { it.instanceId == installation.instanceId }
                    ?.map { it.id }
                    .orEmpty()
            )
        }
        cancelDetachedWork { it?.instanceId != installation.instanceId }
        pairingMemos.keys.removeAll { it.first?.instanceId == installation.instanceId }
        archiveStore.purge(installation.instanceId)
        workspaceCache.purge(installation.instanceId, knownWorkspaceIds)
        scheduledCache.purge(installation.instanceId)
        usageCache.purge(installation.instanceId)
        readSnapshotCache.purge(installation.instanceId)
        botCache.purge(installation.instanceId, installation.deviceId)
        botSessionStore.purgeInstance(installation.instanceId)
        chatCache.purge(installation.instanceId)
        draftStore.purge(installation.instanceId)
        modelPreferenceStore.purge(installation.instanceId)
        navigationStore.purge(installation.instanceId)
        installationStore.removeInstallation(id)
        if (!wasActive) refreshIntentCatalog()
    }

    private fun refreshIntentCatalog() {
        val installations = installationStore.installations.value
        val activeInstanceId = installationStore.activeInstallationId.value
        val workspaceRecords = if (activeInstanceId == null) {
            emptyList()
        } else {
            _workspaces.value.map { workspace ->
                AidenIntentWorkspaceRecord(
                    id = workspace.id,
                    instanceId = activeInstanceId,
                    name = workspace.name
                )
            }
        }
        intentCatalogStore?.update(
            installations = installations.map { AidenIntentInstallationRecord(it.id, it.name) },
            activeInstallationId = activeInstanceId,
            workspaces = workspaceRecords,
            forInstanceId = activeInstanceId
        )
    }

    private fun cachedWorkspaces(instanceId: String): List<AidenWorkspace> =
        readSnapshotCache.load(instanceId, AidenReadSnapshotKeys.WORKSPACES, workspaceListSerializer).orEmpty()

    private fun isCurrent(generation: Long, installationId: String, client: AidenRemoteClient): Boolean =
        activationGeneration == generation &&
            installationStore.activeInstallation?.id == installationId &&
            _client.value === client

    suspend fun createWorkspace(create: AidenWorkspaceCreate): AidenWorkspace {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        return try {
            val created = currentClient.createWorkspace(create)
            // Reconcile at once with the server's answer; the refresh follows.
            if (_workspaces.value.none { it.id == created.id }) _workspaces.value = _workspaces.value + created
            refreshWorkspaces()
            created
        } finally {
            _isMutating.value = false
        }
    }

    suspend fun updateWorkspace(
        workspace: AidenWorkspace,
        name: String? = null,
        permission: AidenWorkspacePermission? = null,
        memoryEnabled: Boolean? = null
    ): AidenWorkspace {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        return try {
            val updated = currentClient.updateWorkspace(
                id = workspace.id,
                revision = workspace.revision,
                patch = AidenWorkspacePatch(name = name, permission = permission, memoryEnabled = memoryEnabled)
            )
            _workspaces.value = _workspaces.value.map { if (it.id == updated.id) updated else it }
            refreshWorkspaces()
            updated
        } finally {
            _isMutating.value = false
        }
    }

    suspend fun removeWorkspace(workspace: AidenWorkspace) {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        try {
            currentClient.removeWorkspace(workspace.id, workspace.revision)
            archiveStore.forget(workspace.id, activeInstanceId)
            _workspaces.value = _workspaces.value.filterNot { it.id == workspace.id }
            refreshWorkspaces()
        } finally {
            _isMutating.value = false
        }
    }

    suspend fun removeManagedWorktree(workspace: AidenWorkspace): AidenGitResult {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        return try {
            val res = currentClient.deleteManagedGitWorktree(
                workspaceId = workspace.id,
                revision = workspace.revision,
                idempotencyKey = UUID.randomUUID()
            )
            archiveStore.forget(workspace.id, activeInstanceId)
            _workspaces.value = _workspaces.value.filterNot { it.id == workspace.id }
            refreshWorkspaces()
            res
        } finally {
            _isMutating.value = false
        }
    }

    suspend fun pairWithQRCode(payload: AidenPairingPayload, deviceName: String = "Android Device"): AidenInstallation {
        val exchange = AidenRemoteClient.pair(
            payload = payload,
            deviceName = deviceName,
            deviceType = AidenDeviceType.ANDROID_PHONE
        )
        val installation = installationStore.addInstallation(exchange, payload.trust)
        refreshClient()
        return installation
    }

    suspend fun pairWithManualCode(code: String, endpoint: String, deviceName: String = "Android Device"): AidenInstallation {
        val result = AidenRemoteClient.pair(
            manualCode = code,
            endpoint = endpoint,
            deviceName = deviceName,
            deviceType = AidenDeviceType.ANDROID_PHONE
        )
        val installation = installationStore.addInstallation(result.exchange, result.payload.trust)
        refreshClient()
        return installation
    }
}
