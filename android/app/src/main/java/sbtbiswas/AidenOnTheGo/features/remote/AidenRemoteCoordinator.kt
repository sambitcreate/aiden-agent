package sbtbiswas.AidenOnTheGo.features.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.intents.AidenIntentInstallationRecord
import sbtbiswas.AidenOnTheGo.intents.AidenIntentWorkspaceRecord
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenScheduledTaskCache
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceArchiveStore
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.io.File
import java.util.UUID

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
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + Job())
) {
    val archiveStore = AidenWorkspaceArchiveStore(storageDir)
    val workspaceCache = AidenWorkspaceEnvironmentCache(File(storageDir, "workspace_cache"))
    val scheduledCache = AidenScheduledTaskCache(File(storageDir, "scheduled_tasks_cache"))
    val usageCache = AidenUsageCache(File(storageDir, "usage_cache"))
    val botCache = AidenBotCache(storageDir)

    private val _connectionState = MutableStateFlow(
        if (installationStore.activeInstallation == null) {
            AidenConnectionState.NEEDS_PAIRING
        } else {
            AidenConnectionState.CONNECTING
        }
    )
    val connectionState: StateFlow<AidenConnectionState> = _connectionState.asStateFlow()

    private val _serverInfo = MutableStateFlow<AidenServer?>(null)
    val serverInfo: StateFlow<AidenServer?> = _serverInfo.asStateFlow()

    private val _client = MutableStateFlow<AidenRemoteClient?>(null)
    val client: StateFlow<AidenRemoteClient?> = _client.asStateFlow()

    private val _workspaces = MutableStateFlow<List<AidenWorkspace>>(emptyList())
    val workspaces: StateFlow<List<AidenWorkspace>> = _workspaces.asStateFlow()

    private val _hasCompletedWorkspaceRefresh = MutableStateFlow(false)
    val hasCompletedWorkspaceRefresh: StateFlow<Boolean> = _hasCompletedWorkspaceRefresh.asStateFlow()

    private val _isMutating = MutableStateFlow(false)
    val isMutating: StateFlow<Boolean> = _isMutating.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()
    private var activationGeneration: Long = 0

    val activeInstanceId: String?
        get() = installationStore.activeInstallation?.instanceId

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
        if (installation == null) {
            _client.value = null
            _serverInfo.value = null
            _workspaces.value = emptyList()
            _hasCompletedWorkspaceRefresh.value = false
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val credential = installationStore.getCredential(installation)
        if (credential == null) {
            _client.value = null
            _serverInfo.value = null
            _workspaces.value = emptyList()
            _hasCompletedWorkspaceRefresh.value = false
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val newClient = AidenRemoteClient(installation, credential)
        botCache.activate(installation.instanceId, installation.deviceId)
        _client.value = newClient
        _serverInfo.value = null
        _workspaces.value = emptyList()
        _hasCompletedWorkspaceRefresh.value = false
        _connectionState.value = AidenConnectionState.CONNECTING

        scope.launch {
            try {
                val server = newClient.server()
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                _serverInfo.value = server
                _connectionState.value = AidenConnectionState.CONNECTED
                val serverCapabilities = server.serverCapabilities ?: server.capabilities
                if (!serverCapabilities.contains(AidenRemoteCapability.SCHEDULE_READ)) {
                    scheduledCache.purge(installation.instanceId)
                }
                installationStore.updateServerCapabilities(
                    instanceId = installation.instanceId,
                    serverCapabilities = serverCapabilities,
                    serverName = server.name
                )
                refreshWorkspaces(generation)
            } catch (e: AidenRemoteClientException.Server) {
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                if (e.isCredentialRevoked) {
                    removeInstallation(installation.id)
                    _connectionState.value = AidenConnectionState.NEEDS_PAIRING
                } else {
                    _connectionState.value = AidenConnectionState.OFFLINE
                }
            } catch (_: Exception) {
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                _connectionState.value = AidenConnectionState.OFFLINE
            }
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
        archiveStore.purge(installation.instanceId)
        workspaceCache.purge(installation.instanceId, knownWorkspaceIds)
        scheduledCache.purge(installation.instanceId)
        usageCache.purge(installation.instanceId)
        botCache.purge(installation.instanceId, installation.deviceId)
        chatCache.purge(installation.instanceId)
        draftStore.purge(installation.instanceId)
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

    private fun isCurrent(generation: Long, installationId: String, client: AidenRemoteClient): Boolean =
        activationGeneration == generation &&
            installationStore.activeInstallation?.id == installationId &&
            _client.value === client

    suspend fun createWorkspace(create: AidenWorkspaceCreate): AidenWorkspace {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        return try {
            val created = currentClient.createWorkspace(create)
            refreshWorkspaces()
            created
        } finally {
            _isMutating.value = false
        }
    }

    suspend fun updateWorkspace(
        workspace: AidenWorkspace,
        name: String? = null,
        permission: AidenWorkspacePermission? = null
    ): AidenWorkspace {
        val currentClient = _client.value ?: throw AidenRemoteClientException.Disconnected()
        _isMutating.value = true
        return try {
            val updated = currentClient.updateWorkspace(
                id = workspace.id,
                revision = workspace.revision,
                patch = AidenWorkspacePatch(name = name, permission = permission)
            )
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
