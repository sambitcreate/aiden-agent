package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth

interface AidenBotAllowedTransport {
    suspend fun list(botId: String, cursor: String?): AidenBotAllowedList
    suspend fun remove(botId: String, id: String): AidenBotAllowedList
}
fun aidenBotAllowedSupported(installation: AidenInstallation?): Boolean =
    installation?.isBotsEligible == true && installation.hasNegotiatedAccess(AidenRemoteCapability.BOT_ALLOWED)

class AidenRemoteBotAllowedTransport(private val client: AidenRemoteClient): AidenBotAllowedTransport {
    override suspend fun list(botId: String, cursor: String?) = client.botAllowed(botId, cursor)
    override suspend fun remove(botId: String, id: String) = client.removeBotAllowed(botId, id)
}
data class AidenBotAllowedState(val entries: List<AidenBotAllowedEntry> = emptyList(), val loaded: Boolean = false,
    val loading: Boolean = false, val removing: String? = null, val error: String? = null) {
    val countSummary: String? get() = if (!loaded) null else if (entries.isEmpty()) "Nothing yet" else entries.size.toString()
}
class AidenBotAllowedController(private val botId: String, private val transport: AidenBotAllowedTransport,
    private val isCurrent: () -> Boolean = { true }) {
    private val mutable = MutableStateFlow(AidenBotAllowedState())
    val state = mutable.asStateFlow()
    private var generation = 0
    fun invalidate() { generation++; mutable.value = AidenBotAllowedState() }
    private fun current(mark: Int) = mark == generation && isCurrent()
    private suspend fun collect(first: AidenBotAllowedList, mark: Int): List<AidenBotAllowedEntry> {
        var page = first; val rows = mutableListOf<AidenBotAllowedEntry>(); val ids = mutableSetOf<String>(); val cursors = mutableSetOf<String>()
        while (true) {
            if (!current(mark)) throw CancellationException()
            check(page.botId == botId)
            page.entries.forEach { check(ids.add(it.id)); rows.add(it) }
            val cursor = page.nextCursor ?: return rows
            check(cursors.add(cursor) && cursors.size <= 128)
            page = transport.list(botId, cursor)
        }
    }
    private suspend fun collectRefreshing(first: AidenBotAllowedList, mark: Int): List<AidenBotAllowedEntry> = try { collect(first,mark) }
        catch (e: AidenRemoteClientException.Server) {
            if (e.statusCode != 400 || !current(mark)) throw e
            collect(transport.list(botId,null),mark)
        }
    suspend fun load() {
        if (!isCurrent()) { invalidate(); return }
        val mark = ++generation
        mutable.value = mutable.value.copy(loading = true, removing = null, error = null)
        try {
            val rows = collectRefreshing(transport.list(botId,null),mark)
            if (current(mark)) mutable.value = AidenBotAllowedState(entries = rows, loaded = true)
        } catch (e: CancellationException) { if (current(mark)) throw e
        } catch (_: Exception) { if (current(mark)) mutable.value = mutable.value.copy(loading = false, error = "Allowed without asking couldn’t be loaded. Please try again.") }
    }
    suspend fun remove(id: String) {
        val before = mutable.value
        if (!isCurrent() || before.loading || before.removing != null || before.entries.none { it.id == id }) return
        val mark = ++generation
        mutable.value = before.copy(removing = id, error = null)
        try {
            val rows = collectRefreshing(transport.remove(botId,id),mark)
            if (current(mark)) mutable.value = AidenBotAllowedState(entries = rows, loaded = true)
        } catch (e: CancellationException) { if (current(mark)) throw e
        } catch (_: Exception) { if (current(mark)) mutable.value = before.copy(error = "That entry wasn’t removed. Please try again.") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotAllowedScreen(botId: String, coordinator: AidenRemoteCoordinator, onNavigateBack: () -> Unit) {
    val palette = AidenTheme.palette
    val client by coordinator.client.collectAsStateWithLifecycle()
    val installations by coordinator.installationStore.installations.collectAsStateWithLifecycle()
    val activeId by coordinator.installationStore.activeInstallationId.collectAsStateWithLifecycle()
    val installation = installations.firstOrNull { it.id == activeId }
    val cl = client
    val held = aidenBotAllowedSupported(installation)
    val canWrite = installation?.canWriteBots == true
    val scope = rememberCoroutineScope()
    val controller = remember(botId, cl, held, installation?.deviceCapabilities, installation?.serverCapabilities) { cl?.takeIf { held }?.let {
        val instance = coordinator.activeInstanceId
        val grants = installation?.deviceCapabilities
        val offered = installation?.serverCapabilities
        AidenBotAllowedController(botId,AidenRemoteBotAllowedTransport(it)) {
            coordinator.holdsReadAuthority(it,instance) && aidenBotAllowedSupported(coordinator.installationStore.activeInstallation) && coordinator.installationStore.activeInstallation?.deviceCapabilities == grants && coordinator.installationStore.activeInstallation?.serverCapabilities == offered
        }
    } }
    DisposableEffect(controller) { onDispose { controller?.invalidate() } }
    LaunchedEffect(controller) { controller?.load() }
    val ui = controller?.state?.collectAsStateWithLifecycle()?.value ?: AidenBotAllowedState()
    Scaffold(containerColor = palette.canvas, topBar = { TopAppBar(title = { Text("Allowed without asking") }, navigationIcon = {
        IconButton(onClick = onNavigateBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack,"Back") }
    }, colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas)) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).aidenReadableWidth(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { AidenTonalButton(text = "Refresh", enabled = controller != null && !ui.loading, onClick = { scope.launch { controller?.load() } }) }
            ui.error?.let { item { Text(it,color = palette.danger,style = MaterialTheme.typography.bodySmall) } }
            if (!held) item { Text("This Mac hasn’t granted access to this list.",color = palette.secondary) }
            else if (!ui.loaded) item { Text("Loading allowed actions…",color = palette.secondary) }
            else if (ui.entries.isEmpty()) item { Text("Choose Always allow on a Bot’s approval card to stop a question you keep answering.",color = palette.secondary) }
            items(ui.entries,key = { it.id }) { entry ->
                Surface(color = palette.raised,shape = MaterialTheme.shapes.large) {
                    Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(entry.what,color = palette.foreground,style = MaterialTheme.typography.bodyLarge)
                        Text("Added ${entry.addedAt.atZone(java.time.ZoneId.systemDefault()).toLocalDate()}",color = palette.secondary,style = MaterialTheme.typography.bodySmall)
                        entry.uses?.let { Text(if (it == 0L) "Not used yet" else "Used $it ${if (it == 1L) "time" else "times"}",color = palette.secondary,style = MaterialTheme.typography.bodySmall) }
                        TextButton(enabled = canWrite && ui.removing == null && !ui.loading, onClick = { scope.launch { controller?.remove(entry.id) } }) { Text(if (ui.removing == entry.id) "Removing…" else "Remove") }
                    }
                }
            }
        }
    }
}
