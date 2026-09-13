package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator

/** The selected tool belongs to the session, not the current window width. */
@Composable
fun AidenChatEnvironmentPane(
    workspaceId: String,
    chatId: String,
    coordinator: AidenRemoteCoordinator,
    onReturnToChat: () -> Unit,
    onToggleSplit: (() -> Unit)? = null,
    isSplit: Boolean = false
) {
    val state: AidenEnvironmentPaneState = androidx.lifecycle.viewmodel.compose.viewModel(
        viewModelStoreOwner = androidx.activity.compose.LocalActivity.current as androidx.lifecycle.ViewModelStoreOwner,
        key = "environment:${coordinator.activeInstanceId}:${coordinator.installationStore.activeInstallation?.deviceId}:$workspaceId:$chatId"
    )
    val requestedTool by state.selectedTool.collectAsState()
    val server by coordinator.serverInfo.collectAsState()
    val tools = buildList {
        add("Files")
        if (server?.features?.contains(sbtbiswas.AidenOnTheGo.models.AidenWorkspaceSubagents.FEATURE) == true) add("Subagents")
        add("Browser")
    }
    val selectedTool = tools.indexOf(if (requestedTool == "Changes") "Files" else requestedTool).takeIf { it >= 0 } ?: 0
    val toolState = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    Column(Modifier.fillMaxSize()) {
        Row {
            ScrollableTabRow(selectedTabIndex = selectedTool, modifier = Modifier.weight(1f), edgePadding = 0.dp) {
                tools.forEachIndexed { index, title ->
                    Tab(selected = selectedTool == index, onClick = { state.select(title) }, text = { Text(title) })
                }
            }
            if (onToggleSplit != null) TextButton(onClick = onToggleSplit) { Text(if (isSplit) "Full pane" else "Split right") }
            TextButton(onClick = onReturnToChat) { Text("Chat") }
        }
        Box(Modifier.weight(1f)) {
            toolState.SaveableStateProvider(tools[selectedTool]) {
                when (tools[selectedTool]) {
                    "Files" -> AidenFilesChangesPane(workspaceId, chatId, coordinator, onReturnToChat)
                    "Subagents" -> AidenSubagentsPane(workspaceId, chatId, coordinator)
                    "Browser" -> AidenBrowserPane(workspaceId, chatId, coordinator)
                }
            }
        }
    }
}

/** The Activity's SavedStateHandle restores selection without storing server capabilities. */
class AidenEnvironmentPaneState(private val savedState: androidx.lifecycle.SavedStateHandle) : androidx.lifecycle.ViewModel() {
    private val choices = listOf("Files", "Changes", "Subagents", "Browser")
    init {
        val previous = savedState.get<Any>("tool")
        if (previous is Int) savedState["tool"] = choices.getOrElse(previous) { "Files" }
    }
    val selectedTool = savedState.getStateFlow("tool", "Files")
    val fileMode = savedState.getStateFlow("fileMode", "Modified")
    fun selectFileMode(mode: String) { if (mode in setOf("Modified", "All Files")) savedState["fileMode"] = mode }
    fun select(tool: String) { if (tool in choices) { savedState["tool"] = tool; if (tool == "Changes") selectFileMode("Modified") } }
}

/** One files surface, with retained editors and Git state on either side of the filter. */
@Composable
fun AidenFilesChangesPane(workspaceId: String, chatId: String, coordinator: AidenRemoteCoordinator, onClose: () -> Unit) {
    val state: AidenEnvironmentPaneState = androidx.lifecycle.viewmodel.compose.viewModel(
        viewModelStoreOwner = androidx.activity.compose.LocalActivity.current as androidx.lifecycle.ViewModelStoreOwner,
        key = "environment:${coordinator.activeInstanceId}:${coordinator.installationStore.activeInstallation?.deviceId}:$workspaceId:$chatId"
    )
    val mode by state.fileMode.collectAsState()
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val buckets = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = if (mode == "Modified") 0 else 1) {
            listOf("Modified", "All Files").forEach { title ->
                Tab(selected = mode == title, onClick = { focus.clearFocus(); keyboard?.hide(); state.selectFileMode(title) }, text = { Text(title) })
            }
        }
        Box(Modifier.weight(1f)) {
            buckets.SaveableStateProvider(mode) {
                if (mode == "Modified") AidenGitScreen(workspaceId, coordinator, onClose, readOnlyReview = true)
                else AidenWorkspaceEnvironmentScreen(workspaceId, coordinator, onClose)
            }
        }
    }
}
