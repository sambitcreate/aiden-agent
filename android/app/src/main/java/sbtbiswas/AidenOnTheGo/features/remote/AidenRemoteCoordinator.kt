package sbtbiswas.AidenOnTheGo.features.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenScheduledTaskCache
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceArchiveStore
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
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
    private val storageDir: File? = null,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + Job())
) {
    val archiveStore = AidenWorkspaceArchiveStore(storageDir ?: File("/data/data/sbtbiswas.AidenOnTheGo/files"))
    val workspaceCache = AidenWorkspaceEnvironmentCache(File(storageDir ?: File("/data/data/sbtbiswas.AidenOnTheGo/files"), "workspace_cache"))
    val scheduledCache = AidenScheduledTaskCache(File(storageDir ?: File("/data/data/sbtbiswas.AidenOnTheGo/files"), "scheduled_tasks_cache"))
    val usageCache = AidenUsageCache(File(storageDir ?: File("/data/data/sbtbiswas.AidenOnTheGo/files"), "usage_cache"))
    val botCache = AidenBotCache(storageDir ?: File("/data/data/sbtbiswas.AidenOnTheGo/files"))

    private val _connectionState = MutableStateFlow(AidenConnectionState.CONNECTING)
    val connectionState: StateFlow<AidenConnectionState> = _connectionState.asStateFlow()

    private val _serverInfo = MutableStateFlow<AidenServer?>(null)
    val serverInfo: StateFlow<AidenServer?> = _serverInfo.asStateFlow()

    private val _client = MutableStateFlow<AidenRemoteClient?>(null)
    val client: StateFlow<AidenRemoteClient?> = _client.asStateFlow()

    private val _workspaces = MutableStateFlow<List<AidenWorkspace>>(emptyList())
    val workspaces: StateFlow<List<AidenWorkspace>> = _workspaces.asStateFlow()

    private val _isMutating = MutableStateFlow(false)
    val isMutating: StateFlow<Boolean> = _isMutating.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()
    private var activationGeneration: Long = 0

    val activeInstanceId: String?
        get() = installationStore.activeInstallation?.instanceId

    init {
        scope.launch {
            installationStore.activeInstallationId.collect {
                refreshClient()
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
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val credential = installationStore.getCredential(installation)
        if (credential == null) {
            _client.value = null
            _serverInfo.value = null
            _workspaces.value = emptyList()
            _connectionState.value = AidenConnectionState.NEEDS_PAIRING
            return
        }

        val newClient = AidenRemoteClient(installation, credential)
        botCache.activate(installation.instanceId, installation.deviceId)
        _client.value = newClient
        _serverInfo.value = null
        _workspaces.value = emptyList()
        _connectionState.value = AidenConnectionState.CONNECTING

        scope.launch {
            try {
                val server = newClient.server()
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                _serverInfo.value = server
                _connectionState.value = AidenConnectionState.CONNECTED
                installationStore.updateServerCapabilities(
                    instanceId = installation.instanceId,
                    serverCapabilities = server.serverCapabilities ?: server.capabilities,
                    serverName = server.name
                )
                refreshWorkspaces(generation)
            } catch (e: AidenRemoteClientException.Server) {
                if (!isCurrent(generation, installation.id, newClient)) return@launch
                if (e.isCredentialRevoked) {
                    installationStore.removeInstallation(installation.id)
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
            } catch (_: Exception) {}
        }
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
