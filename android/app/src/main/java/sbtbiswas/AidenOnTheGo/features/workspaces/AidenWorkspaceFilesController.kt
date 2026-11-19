package sbtbiswas.AidenOnTheGo.features.workspaces

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileAvailability
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileDocument
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileIndex
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileTree
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenWorkspaceEnvironmentCache
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode

interface AidenWorkspaceFilesRemote {
    suspend fun workspaceFilePage(
        workspaceId: String,
        directoryId: String? = null,
        cursor: String? = null
    ): AidenWorkspaceFileIndex

    suspend fun workspaceFiles(workspaceId: String): AidenWorkspaceFileIndex
    suspend fun workspaceFile(workspaceId: String, fileId: String): AidenWorkspaceFileDocument
    suspend fun workspaceLinkedFile(workspaceId: String, reference: String): AidenWorkspaceFileDocument
    suspend fun writeWorkspaceFile(
        workspaceId: String,
        fileId: String,
        displayPath: String,
        content: String,
        expectedVersion: String
    ): AidenWorkspaceFileDocument
}

class AidenRemoteClientWorkspaceFiles(val client: AidenRemoteClient) : AidenWorkspaceFilesRemote {
    override suspend fun workspaceFilePage(workspaceId: String, directoryId: String?, cursor: String?) =
        client.workspaceFilePage(workspaceId, directoryId, cursor)

    override suspend fun workspaceFiles(workspaceId: String) = client.workspaceFiles(workspaceId)
    override suspend fun workspaceFile(workspaceId: String, fileId: String) =
        client.workspaceFile(workspaceId, fileId)

    override suspend fun workspaceLinkedFile(workspaceId: String, reference: String) =
        client.workspaceLinkedFile(workspaceId, reference)

    override suspend fun writeWorkspaceFile(
        workspaceId: String,
        fileId: String,
        displayPath: String,
        content: String,
        expectedVersion: String
    ) = client.writeWorkspaceFile(workspaceId, fileId, displayPath, content, expectedVersion)
}

data class AidenWorkspaceFilesStrings(
    val treeLimit: String = "The loaded tree reached 4,000 entries. Refresh Files to browse another folder.",
    val openFailed: String = "This workspace file could not be opened. Browse Files to locate it.",
    val staleFolderRecovery: String = "Files refreshed because that folder link is no longer current. Reopen the folder to continue.",
    val staleFileRecovery: String = "Files refreshed because that file link is no longer current. Reopen the file to continue."
)

data class AidenWorkspaceFilesState(
    val fileIndex: AidenWorkspaceFileIndex? = null,
    val expanded: Set<String> = emptySet(),
    val loadedFolders: Set<String> = emptySet(),
    val cursors: Map<String, String> = emptyMap(),
    val loadingFolders: Set<String> = emptySet(),
    val selectedFile: AidenWorkspaceFileDocument? = null,
    val draftContent: String = "",
    val originalContent: String = "",
    val isDirty: Boolean = false,
    val isEditing: Boolean = false,
    val isOfflineIndex: Boolean = false,
    val isOfflineDocument: Boolean = false,
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val errorMessage: String? = null,
    val showConflictDialog: Boolean = false,
    val connected: Boolean = false,
    val hasClient: Boolean = false
) {
    val availability: AidenWorkspaceFileAvailability
        get() = AidenWorkspaceFileAvailability(isOfflineIndex, isOfflineDocument, connected)
}

internal fun isStaleWorkspaceFileHandleError(error: Throwable): Boolean =
    error is AidenRemoteClientException.Server &&
        (error.body.code == AidenRemoteErrorCode.HANDLE_INVALID ||
            error.body.code == AidenRemoteErrorCode.HANDLE_EXPIRED)

class AidenWorkspaceFilesController(
    private val scope: CoroutineScope,
    private val workspaceId: String,
    private val cache: AidenWorkspaceEnvironmentCache,
    private var strings: AidenWorkspaceFilesStrings = AidenWorkspaceFilesStrings()
) {
    private val _state = MutableStateFlow(AidenWorkspaceFilesState())
    val state: StateFlow<AidenWorkspaceFilesState> = _state.asStateFlow()

    private var activeInstanceId: String? = null
    private var remote: AidenWorkspaceFilesRemote? = null
    private var connected: Boolean = false
    private var ownerGeneration = 0L
    private var requestRevision = 0
    private var openRevision = 0

    fun bind(
        instanceId: String?,
        remote: AidenWorkspaceFilesRemote?,
        connected: Boolean,
        strings: AidenWorkspaceFilesStrings = this.strings
    ) {
        this.strings = strings
        val ownerChanged = instanceId != this.activeInstanceId || !sameRemote(this.remote, remote)
        this.activeInstanceId = instanceId
        this.remote = remote
        this.connected = connected
        if (ownerChanged) {
            ownerGeneration += 1
            requestRevision += 1
            openRevision += 1
            _state.value = AidenWorkspaceFilesState(connected = connected, hasClient = remote != null)
        } else {
            _state.update { it.copy(connected = connected, hasClient = remote != null) }
        }
    }

    private fun sameRemote(left: AidenWorkspaceFilesRemote?, right: AidenWorkspaceFilesRemote?): Boolean =
        when {
            left === right -> true
            left is AidenRemoteClientWorkspaceFiles && right is AidenRemoteClientWorkspaceFiles -> left.client === right.client
            else -> false
        }

    fun dismissError() {
        _state.update { it.copy(errorMessage = null) }
    }

    fun dismissConflictDialog() {
        _state.update { it.copy(showConflictDialog = false) }
    }

    fun setEditing(editing: Boolean) {
        _state.update { it.copy(isEditing = editing) }
    }

    fun updateDraft(content: String) {
        _state.update { it.copy(draftContent = content, isDirty = content != it.originalContent) }
    }

    fun closeSelectedFile(discardChanges: Boolean = false) {
        _state.update { current ->
            if (!discardChanges && current.isDirty) current
            else current.copy(
                selectedFile = null,
                draftContent = current.originalContent,
                isDirty = false,
                isEditing = false,
                showConflictDialog = false
            )
        }
    }

    fun refreshFiles() {
        val currentRemote = remote
        val instanceId = activeInstanceId
        val capturedOwner = ownerGeneration
        if (currentRemote != null && connected) {
            if (_state.value.isLoading) return
            // Show the saved tree at once while the desktop answers. It stays read-only
            // (its folder cursors may be stale) until the fresh index replaces it.
            if (_state.value.fileIndex == null && instanceId != null) {
                cache.load(instanceId, workspaceId)?.let { snapshot ->
                    _state.update { it.copy(fileIndex = snapshot.index, isOfflineIndex = true) }
                }
            }
            requestRevision += 1
            val revision = requestRevision
            _state.update { it.copy(isLoading = true, errorMessage = null) }
            scope.launch {
                try {
                    val index = try {
                        currentRemote.workspaceFilePage(workspaceId)
                    } catch (error: AidenRemoteClientException.Server) {
                        if (error.statusCode != 400 && error.statusCode != 404) throw error
                        currentRemote.workspaceFiles(workspaceId)
                    }
                    if (capturedOwner != ownerGeneration || revision != requestRevision) return@launch
                    _state.update {
                        it.copy(
                            expanded = emptySet(),
                            loadedFolders = setOf(""),
                            loadingFolders = emptySet(),
                            cursors = index.nextCursor?.let { cursor -> mapOf("" to cursor) } ?: emptyMap(),
                            fileIndex = index,
                            isOfflineIndex = false
                        )
                    }
                    if (instanceId != null) {
                        cache.store(index, instanceId, workspaceId)
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (capturedOwner != ownerGeneration || revision != requestRevision) return@launch
                    val snapshot = instanceId?.let { cache.load(it, workspaceId) }
                    _state.update {
                        it.copy(
                            errorMessage = error.message ?: error.localizedMessage,
                            fileIndex = snapshot?.index ?: it.fileIndex,
                            isOfflineIndex = if (snapshot != null) true else it.isOfflineIndex
                        )
                    }
                } finally {
                    if (capturedOwner == ownerGeneration && revision == requestRevision) {
                        _state.update { it.copy(isLoading = false) }
                    }
                }
            }
        } else if (instanceId != null) {
            val snapshot = cache.load(instanceId, workspaceId)
            _state.update {
                it.copy(
                    fileIndex = snapshot?.index ?: it.fileIndex,
                    isOfflineIndex = if (snapshot != null) true else it.isOfflineIndex,
                    isLoading = false
                )
            }
        } else {
            _state.update { it.copy(isLoading = false) }
        }
    }

    private suspend fun recoverFromStaleHandle(
        message: String,
        capturedOwner: Long,
        openFence: Int? = null
    ) {
        if (capturedOwner != ownerGeneration) return
        val instanceId = activeInstanceId
        val currentRemote = remote
        val alreadyLoading = _state.value.isLoading
        _state.update { current ->
            current.copy(
                fileIndex = null,
                expanded = emptySet(),
                loadedFolders = emptySet(),
                cursors = emptyMap(),
                loadingFolders = emptySet(),
                errorMessage = if (openFence == null || openFence == openRevision) message else current.errorMessage
            )
        }
        if (alreadyLoading) return
        requestRevision += 1
        val recoveryRevision = requestRevision
        _state.update { it.copy(isLoading = true) }
        try {
            if (currentRemote != null && connected) {
                try {
                    val index = try {
                        currentRemote.workspaceFilePage(workspaceId)
                    } catch (error: AidenRemoteClientException.Server) {
                        if (error.statusCode != 400 && error.statusCode != 404) throw error
                        currentRemote.workspaceFiles(workspaceId)
                    }
                    if (capturedOwner != ownerGeneration || recoveryRevision != requestRevision) return
                    _state.update { current ->
                        current.copy(
                            fileIndex = index,
                            expanded = emptySet(),
                            loadedFolders = setOf(""),
                            loadingFolders = emptySet(),
                            cursors = index.nextCursor?.let { cursor -> mapOf("" to cursor) } ?: emptyMap(),
                            isOfflineIndex = false,
                            errorMessage = if (openFence == null || openFence == openRevision) message else current.errorMessage
                        )
                    }
                    if (instanceId != null) {
                        cache.store(index, instanceId, workspaceId)
                    }
                    return
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    if (capturedOwner != ownerGeneration || recoveryRevision != requestRevision) return
                    if (openFence == null || openFence == openRevision) {
                        _state.update { it.copy(errorMessage = error.message ?: error.localizedMessage ?: message) }
                    }
                }
            }
            val snapshot = instanceId?.let { cache.load(it, workspaceId) }
            if (snapshot != null && capturedOwner == ownerGeneration && recoveryRevision == requestRevision) {
                _state.update { it.copy(fileIndex = snapshot.index, isOfflineIndex = true) }
            }
        } finally {
            if (capturedOwner == ownerGeneration && recoveryRevision == requestRevision) {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun loadPage(directory: AidenWorkspaceFileEntry?) {
        val directoryPath = directory?.displayPath ?: ""
        val current = _state.value
        val currentRemote = remote ?: return
        if (!current.availability.canLoadPage || current.isLoading || directoryPath in current.loadingFolders) return
        val capturedOwner = ownerGeneration
        val revision = requestRevision
        val cursor = current.cursors[directoryPath]
        _state.update { it.copy(loadingFolders = it.loadingFolders + directoryPath) }
        scope.launch {
            try {
                val page = currentRemote.workspaceFilePage(workspaceId, directory?.id, cursor)
                if (capturedOwner != ownerGeneration || revision != requestRevision) return@launch
                val previous = _state.value.fileIndex ?: return@launch
                val paths = previous.entries.map { it.displayPath }.toSet()
                val entries = previous.entries + page.entries.filter { it.displayPath !in paths }
                if (entries.size > 4_000) {
                    _state.update { it.copy(errorMessage = strings.treeLimit) }
                    return@launch
                }
                val updated = previous.copy(entries = entries, truncated = previous.truncated || page.truncated)
                _state.update { state ->
                    state.copy(
                        fileIndex = updated,
                        cursors = state.cursors - directoryPath + (page.nextCursor?.let { mapOf(directoryPath to it) } ?: emptyMap()),
                        loadedFolders = state.loadedFolders + directoryPath
                    )
                }
                val instanceId = activeInstanceId
                if (instanceId != null) cache.store(updated, instanceId, workspaceId)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (capturedOwner != ownerGeneration || revision != requestRevision) return@launch
                _state.update { it.copy(expanded = it.expanded - directoryPath, loadingFolders = it.loadingFolders - directoryPath) }
                if (isStaleWorkspaceFileHandleError(error)) {
                    recoverFromStaleHandle(strings.staleFolderRecovery, capturedOwner)
                } else {
                    _state.update { it.copy(errorMessage = error.message ?: error.localizedMessage) }
                }
            } finally {
                if (capturedOwner == ownerGeneration && revision == requestRevision) {
                    _state.update { it.copy(loadingFolders = it.loadingFolders - directoryPath) }
                }
            }
        }
    }

    fun openLinkedReference(reference: String) {
        val currentRemote = remote
        val instanceId = activeInstanceId
        val capturedOwner = ownerGeneration
        openRevision += 1
        val revision = openRevision
        scope.launch {
            var online = false
            val document = try {
                if (currentRemote != null && connected) {
                    currentRemote.workspaceLinkedFile(workspaceId, reference).also { fetched ->
                        if (capturedOwner == ownerGeneration && revision == openRevision && instanceId != null) {
                            cache.store(fetched, instanceId, workspaceId)
                        }
                        online = true
                    }
                } else null
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                null
            } ?: instanceId?.let { cache.document(reference, it, workspaceId) }
            if (capturedOwner != ownerGeneration || revision != openRevision) return@launch
            if (document != null) {
                _state.update {
                    it.copy(
                        selectedFile = document,
                        originalContent = document.content,
                        draftContent = document.content,
                        isDirty = false,
                        isEditing = false,
                        isOfflineDocument = !online,
                        showConflictDialog = false
                    )
                }
            } else {
                _state.update { it.copy(errorMessage = strings.openFailed) }
            }
        }
    }

    fun openEntry(entry: AidenWorkspaceFileEntry) {
        if (entry.kind == AidenWorkspaceFileKind.DIRECTORY) {
            val current = _state.value
            if (entry.displayPath in current.expanded) {
                _state.update { it.copy(expanded = it.expanded - entry.displayPath) }
            } else {
                _state.update { it.copy(expanded = it.expanded + entry.displayPath) }
                if (entry.displayPath !in current.loadedFolders && current.fileIndex?.directoryPath != null) {
                    loadPage(entry)
                }
            }
            return
        }
        if (entry.kind == AidenWorkspaceFileKind.FILE) {
            val currentRemote = remote
            val instanceId = activeInstanceId
            val capturedOwner = ownerGeneration
            openRevision += 1
            val revision = openRevision
            _state.update { it.copy(errorMessage = null) }
            scope.launch {
                if (currentRemote != null && connected) {
                    try {
                        val fetchedDoc = currentRemote.workspaceFile(workspaceId, entry.id)
                        if (capturedOwner != ownerGeneration || revision != openRevision) return@launch
                        _state.update {
                            it.copy(
                                isEditing = false,
                                isOfflineDocument = false,
                                selectedFile = fetchedDoc,
                                originalContent = fetchedDoc.content,
                                draftContent = fetchedDoc.content,
                                isDirty = false,
                                showConflictDialog = false
                            )
                        }
                        if (instanceId != null) {
                            cache.store(fetchedDoc, instanceId, workspaceId)
                        }
                        return@launch
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        if (capturedOwner != ownerGeneration || revision != openRevision) return@launch
                        if (isStaleWorkspaceFileHandleError(error)) {
                            recoverFromStaleHandle(strings.staleFileRecovery, capturedOwner, openFence = revision)
                            return@launch
                        }
                        _state.update { it.copy(errorMessage = error.message ?: error.localizedMessage) }
                    }
                }
                if (instanceId != null) {
                    val snapshot = cache.load(instanceId, workspaceId)
                    val cachedDoc = snapshot?.documents?.get(entry.id)
                        ?: snapshot?.documents?.values?.firstOrNull { it.displayPath == entry.displayPath }
                    if (cachedDoc != null && capturedOwner == ownerGeneration && revision == openRevision) {
                        _state.update {
                            it.copy(
                                isOfflineDocument = true,
                                isEditing = false,
                                selectedFile = cachedDoc,
                                originalContent = cachedDoc.content,
                                draftContent = cachedDoc.content,
                                isDirty = false,
                                showConflictDialog = false
                            )
                        }
                    }
                }
            }
        }
    }

    fun saveDocument() {
        val current = _state.value
        val doc = current.selectedFile ?: return
        val currentRemote = remote ?: return
        if (current.isSaving || !current.availability.canEditDocument) return
        val capturedOwner = ownerGeneration
        val instanceId = activeInstanceId
        val contentToSave = current.draftContent
        _state.update { it.copy(isSaving = true, errorMessage = null) }
        scope.launch {
            try {
                val updated = currentRemote.writeWorkspaceFile(
                    workspaceId = workspaceId,
                    fileId = doc.id,
                    displayPath = doc.displayPath,
                    content = contentToSave,
                    expectedVersion = doc.version
                )
                if (capturedOwner != ownerGeneration) return@launch
                val currentIndex = _state.value.fileIndex
                val rebound = currentIndex?.let { AidenWorkspaceFileTree.rebind(it, doc.id, updated.id) }
                _state.update { state ->
                    state.copy(
                        selectedFile = updated,
                        fileIndex = rebound ?: state.fileIndex,
                        originalContent = updated.content,
                        draftContent = updated.content,
                        isDirty = false,
                        showConflictDialog = false
                    )
                }
                if (instanceId != null) {
                    if (rebound != null && rebound !== currentIndex) {
                        cache.store(rebound, instanceId, workspaceId)
                    }
                    cache.store(updated, instanceId, workspaceId)
                }
            } catch (e: AidenRemoteClientException.Server) {
                if (capturedOwner != ownerGeneration) return@launch
                if (e.body.code == AidenRemoteErrorCode.REVISION_CONFLICT) {
                    _state.update { it.copy(showConflictDialog = true) }
                } else {
                    _state.update { it.copy(errorMessage = e.message) }
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (capturedOwner != ownerGeneration) return@launch
                _state.update { it.copy(errorMessage = e.message ?: e.localizedMessage) }
            } finally {
                if (capturedOwner == ownerGeneration) {
                    _state.update { it.copy(isSaving = false) }
                }
            }
        }
    }

    fun reloadSelectedFile() {
        val doc = _state.value.selectedFile ?: return
        _state.update { it.copy(showConflictDialog = false) }
        val entry = _state.value.fileIndex?.entries?.firstOrNull { it.id == doc.id }
            ?: AidenWorkspaceFileEntry(
                id = doc.id,
                displayPath = doc.displayPath,
                name = doc.displayPath.substringAfterLast('/'),
                kind = AidenWorkspaceFileKind.FILE
            )
        openEntry(entry)
    }
}
