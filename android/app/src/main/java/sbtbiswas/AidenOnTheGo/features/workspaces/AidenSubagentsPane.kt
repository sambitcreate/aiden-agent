package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceSubagent
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceSubagents
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** In-memory summaries only; neither private child data nor raw run IDs are cached on disk. */
class AidenSubagentsPaneState : ViewModel() {
    var result by mutableStateOf<AidenWorkspaceSubagents?>(null)
    var selected by mutableStateOf<AidenWorkspaceSubagent?>(null)
    var error by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var requestRevision = 0L
    var authorizedClient: Any? = null
    fun requireAuthorization() {
        authorizedClient = null
        result = null
        selected = null
        error = null
    }
    fun accept(value: AidenWorkspaceSubagents): Boolean {
        val previous = result?.runs?.associateBy { it.id }.orEmpty()
        if (value.runs.any { it.revision < (previous[it.id]?.revision ?: 0) }) return false
        result = value
        selected = value.runs.firstOrNull { it.id == selected?.id }
        return true
    }
}

@Composable
fun AidenSubagentsPane(workspaceId: String, chatId: String, coordinator: AidenRemoteCoordinator) {
    val client by coordinator.client.collectAsState()
    val instance = coordinator.activeInstanceId
    val state: AidenSubagentsPaneState = androidx.lifecycle.viewmodel.compose.viewModel(
        key = "subagents:$instance:${coordinator.installationStore.activeInstallation?.deviceId}:$workspaceId:$chatId"
    )
    val scope = rememberCoroutineScope()
    fun refresh(reauthorize: Boolean = false) {
        if (reauthorize) state.requireAuthorization()
        val capturedClient = client
        val revision = ++state.requestRevision
        if (capturedClient == null) {
            state.result = null
            state.selected = null
            state.error = "Connect to your Mac to view subagents."
            state.loading = false
            return
        }
        state.loading = true
        scope.launch {
            fun current() = coordinator.client.value === capturedClient && coordinator.activeInstanceId == instance && revision == state.requestRevision
            try {
                val result = capturedClient.workspaceSubagents(workspaceId, chatId)
                if (!current()) return@launch
                state.authorizedClient = capturedClient
                state.error = if (state.accept(result)) null else "The response is older than the current view. Refresh to try again."
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!current()) return@launch
                state.result = null
                state.selected = null
                state.error = if (error is AidenRemoteClientException.Server && error.statusCode == 403)
                    "Allow Subagents viewing for this device in Aiden Settings on your Mac, then refresh."
                else "Subagents could not be loaded. Refresh to try again."
            } finally {
                if (current()) state.loading = false
            }
        }
    }
    LaunchedEffect(client) { refresh(reauthorize = true) }
    DisposableEffect(Unit) {
        onDispose { state.requestRevision += 1; state.loading = false; state.requireAuthorization() }
    }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Subagents", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { refresh() }, enabled = !state.loading) { Text("Refresh") }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = AidenTheme.palette.secondary) }
        val result = state.result.takeIf { client != null && state.authorizedClient === client }
        if (result != null && result.runs.isEmpty()) Text("No subagents for this chat.")
        if (result?.truncated == true) Text("Showing the most recent 100 runs.", color = AidenTheme.palette.secondary)
        LazyColumn(Modifier.weight(1f)) {
            items(result?.runs.orEmpty(), key = { it.id }) { run ->
                TextButton(onClick = { state.selected = run }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        Text(run.label)
                        Text("${run.role.replaceFirstChar { it.uppercase() }} · ${run.state.replace('_', ' ')}", color = AidenTheme.palette.secondary)
                    }
                }
            }
        }
        state.selected?.takeIf { result != null }?.let { run ->
            AlertDialog(
                onDismissRequest = { state.selected = null },
                title = { Text(run.label) },
                text = { Text("${run.role.replaceFirstChar { it.uppercase() }} · ${run.state.replace('_', ' ')}\n\nThis view shows run status. Private child conversations and controls remain on your Mac.") },
                confirmButton = { TextButton(onClick = { state.selected = null }) { Text("Done") } }
            )
        }
    }
}
