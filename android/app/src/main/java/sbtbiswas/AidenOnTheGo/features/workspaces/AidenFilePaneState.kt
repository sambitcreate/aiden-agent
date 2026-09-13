package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.runtime.*
import androidx.lifecycle.ViewModel
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenFileDraftStore

/** Session state survives pane transitions and Activity recreation. */
class AidenFilePaneState : ViewModel() {
    var expandedDirectories by mutableStateOf<Set<String>>(emptySet())
    fun toggleDirectory(path: String) { expandedDirectories = if (path in expandedDirectories) expandedDirectories - path else expandedDirectories + path }
    val contentScroll = androidx.compose.foundation.ScrollState(0)
    val listScroll = androidx.compose.foundation.lazy.LazyListState()
    private var store: AidenFileDraftStore? = null
    private var instance: String = ""
    private var storeGeneration = 0L
    var openRevision = 0L
        private set
    fun beginOpen(): Long { openRevision += 1; return openRevision }
    fun isLatestOpen(revision: Long) = revision == openRevision
    private var workspace: String = ""
    var recovery by mutableStateOf<AidenFileDraftStore.Draft?>(null)
        private set
    fun configure(store: AidenFileDraftStore, instance: String, workspace: String) {
        if (this.store != null) return
        this.store = store
        this.instance = instance
        this.workspace = workspace
        storeGeneration = store.generation(instance)
        recovery = store.load(instance, workspace)
    }
    fun open(document: AidenWorkspaceFileDocument, restore: Boolean = true) {
        val saved = recovery?.takeIf { restore && it.path == document.displayPath }
        selectedFile = if (saved != null) document.copy(version = saved.version) else document
        originalContent = saved?.original ?: document.content
        draftContent = saved?.text ?: document.content
        isDirty = draftContent != originalContent
        if (!restore) persist()
    }
    fun connectionChanged() {
        if (isSaving) errorMessage = "The connection changed while saving. Review the file on your Mac before trying again."
        isSaving = false
    }
    fun saved(document: AidenWorkspaceFileDocument, submittedText: String) {
        if (selectedFile?.displayPath != document.displayPath) return
        val laterText = draftContent
        open(document, restore = false)
        if (laterText != submittedText) edit(laterText)
    }
    fun edit(text: String) {
        openRevision += 1
        draftContent = text
        isDirty = text != originalContent
        persist()
    }
    fun persist() {
        val doc = selectedFile
        recovery = if (isDirty && doc != null) AidenFileDraftStore.Draft(doc.displayPath, originalContent, doc.version, draftContent) else null
        if (store?.save(instance, workspace, recovery, storeGeneration) == false) errorMessage = "The file draft could not be saved on this device. Keep this file open."
    }

    var hasRequested = false
    var loadedClient: Any? = null
    var fileIndex by mutableStateOf<AidenWorkspaceFileIndex?>(null)
    var selectedFile by mutableStateOf<AidenWorkspaceFileDocument?>(null)
    var draftContent by mutableStateOf("")
    var originalContent by mutableStateOf("")
    var isDirty by mutableStateOf(false)
    var isOfflineSnapshot by mutableStateOf(false)
    var searchQuery by mutableStateOf("")
    var isLoading by mutableStateOf(true)
    var isSaving by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    // Dialog States
    var showDiscardConfirmDialog by mutableStateOf(false)
    var showConflictDialog by mutableStateOf(false)

}
