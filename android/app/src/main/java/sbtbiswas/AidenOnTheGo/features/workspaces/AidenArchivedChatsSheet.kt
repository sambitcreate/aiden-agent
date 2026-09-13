package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenChat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenArchivedChatsSheet(coordinator: AidenRemoteCoordinator, onClose: () -> Unit, onRestored: () -> Unit) {
    val client by coordinator.client.collectAsState()
    val scope = rememberCoroutineScope()
    var chats by remember(client) { mutableStateOf<List<AidenChat>>(emptyList()) }
    var error by remember(client) { mutableStateOf<String?>(null) }
    var busy by remember(client) { mutableStateOf(false) }
    fun load() {
        val captured = client ?: return
        busy = true
        scope.launch {
            try {
                val values = captured.chats(includeArchived = true)
                if (coordinator.client.value === captured) chats = values.filter { !it.isBotChat && it.archivedAt != null }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (coordinator.client.value === captured) error = failure.localizedMessage }
            finally { if (coordinator.client.value === captured) busy = false }
        }
    }
    LaunchedEffect(client) { load() }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(16.dp)) {
            Text("Archived chats", style = MaterialTheme.typography.titleLarge)
            Text("Archived on your Mac. Restore a chat to return it to your chat list.")
            TextButton(enabled = !busy, onClick = ::load) { Text("Refresh") }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (!busy && chats.isEmpty() && error == null) Text("No archived chats")
            LazyColumn {
                items(chats, key = { it.id }) { chat ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(chat.title.ifBlank { "Chat" }, modifier = Modifier.weight(1f))
                        TextButton(enabled = !busy, onClick = {
                            val captured = client ?: return@TextButton
                            busy = true
                            scope.launch {
                                try {
                                    val current = captured.chat(chat.id)
                                    if (coordinator.client.value !== captured) return@launch
                                    captured.setChatArchived(chat.id, current.revision, false)
                                    if (coordinator.client.value === captured) { chats = chats.filterNot { it.id == chat.id }; error = null; onRestored() }
                                } catch (cancelled: CancellationException) { throw cancelled }
                                catch (failure: Exception) { if (coordinator.client.value === captured) error = failure.localizedMessage }
                                finally { if (coordinator.client.value === captured) busy = false }
                            }
                        }) { Text("Restore") }
                    }
                }
            }
        }
    }
}
