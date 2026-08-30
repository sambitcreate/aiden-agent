package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import java.util.UUID

enum class AidenBotChatAccessScope(val label: String) {
    BOT("Bot defaults"),
    CHAT("This chat")
}

sealed class AidenBotChatSheet {
    object Access : AidenBotChatSheet()
    data class Profile(val bot: AidenBotSummary) : AidenBotChatSheet()
    data class Edit(val botId: String) : AidenBotChatSheet()
    data class Files(val grant: AidenBotConversationFileGrant) : AidenBotChatSheet()
}

data class AidenBotChatAccessDraft(
    var mode: AidenBotChatAccessMode,
    var providerID: String,
    var modelID: String,
    var fileScopeIDs: Set<String>,
    var shellEnabled: Boolean,
    var connectionIDs: Set<String>,
    var skillIDs: Set<String>,
    var otherCapabilityIDs: Set<String>
) {
    fun selection(): AidenBotCustomSelection {
        return AidenBotCustomSelection(
            fileScopeIds = fileScopeIDs.sorted(),
            shellEnabled = shellEnabled,
            connectionIds = connectionIDs.sorted(),
            skillIds = skillIDs.sorted(),
            otherCapabilityIds = otherCapabilityIDs.sorted(),
            providerId = providerID,
            modelId = modelID
        )
    }

    fun isSaveable(botAccess: AidenBotAccessView, catalog: AidenBotCapabilityCatalog): Boolean {
        if (mode != AidenBotChatAccessMode.CUSTOM) return true
        val sel = try { selection() } catch (_: Exception) { return false }
        return catalog.containsAvailable(sel) && botAccess.permits(sel)
    }

    fun optionAllowed(id: String, options: List<AidenBotCapabilityOption>, botAllowedIDs: Set<String>?): Boolean {
        return options.any { it.id == id && it.available } && (botAllowedIDs?.contains(id) ?: true)
    }

    fun fileScopeAllowed(id: String, catalog: AidenBotCapabilityCatalog, botAccess: AidenBotAccessView): Boolean {
        return catalog.fileScopes.any { it.id == id && it.available } &&
                (botAccess.custom?.let { it.fileScopeIds.contains(id) } ?: true)
    }

    companion object {
        fun create(
            botAccess: AidenBotAccessView,
            chatAccess: AidenBotChatAccessView,
            catalog: AidenBotCapabilityCatalog
        ): AidenBotChatAccessDraft? {
            val startingSelection: AidenBotCustomSelection
            if (chatAccess.custom != null || botAccess.custom != null) {
                startingSelection = chatAccess.custom ?: botAccess.custom!!
            } else {
                val provider = catalog.providers.firstOrNull { it.available && it.models.any { m -> m.available } } ?: return null
                val model = provider.models.firstOrNull { it.available } ?: return null
                startingSelection = AidenBotCustomSelection(
                    fileScopeIds = catalog.fileScopes.filter { it.available }.map { it.id },
                    shellEnabled = catalog.shellAvailable,
                    connectionIds = catalog.connections.filter { it.available }.map { it.id },
                    skillIds = catalog.skills.filter { it.available }.map { it.id },
                    otherCapabilityIds = catalog.otherCapabilities.filter { it.available }.map { it.id },
                    providerId = provider.id,
                    modelId = model.id
                )
            }

            return AidenBotChatAccessDraft(
                mode = chatAccess.mode,
                providerID = startingSelection.providerId,
                modelID = startingSelection.modelId,
                fileScopeIDs = startingSelection.fileScopeIds.toSet(),
                shellEnabled = startingSelection.shellEnabled,
                connectionIDs = startingSelection.connectionIds.toSet(),
                skillIDs = startingSelection.skillIds.toSet(),
                otherCapabilityIDs = startingSelection.otherCapabilityIds.toSet()
            )
        }
    }
}

object AidenBotChatAccessPresentation {
    fun hasFiles(
        botAccess: AidenBotAccessView,
        chatAccess: AidenBotChatAccessView,
        catalog: AidenBotCapabilityCatalog
    ): Boolean {
        val custom = chatAccess.custom ?: botAccess.custom
        if (custom != null) {
            return custom.fileScopeIds.isNotEmpty()
        }
        return catalog.fileScopes.any { it.available }
    }

    fun summary(
        bot: AidenBotDetail,
        chatAccess: AidenBotChatAccessView,
        connected: Boolean
    ): String {
        if (!connected) return "Offline · ${chatAccess.summary}"
        if (bot.health == AidenBotHealth.ARCHIVED) return "Archived · ${chatAccess.summary}"
        if (bot.health != AidenBotHealth.READY) return "Repair access · ${chatAccess.summary}"
        return chatAccess.summary
    }
}

data class AidenBotConversationFileGrant(
    val chatID: String,
    val botID: String,
    val chatAccessRevision: String,
    val botPolicyRevision: String,
    val catalogRevision: String,
    val allowsWrites: Boolean
)

class AidenBotChatToolsModel(
    val chatID: String,
    val botID: String
) {
    var bot by mutableStateOf<AidenBotDetail?>(null)
    var access by mutableStateOf<AidenBotChatAccessView?>(null)
    var catalog by mutableStateOf<AidenBotCapabilityCatalog?>(null)
    var draft by mutableStateOf<AidenBotChatAccessDraft?>(null)
    var savedDraft by mutableStateOf<AidenBotChatAccessDraft?>(null)
    var isLoading by mutableStateOf(false)
    var isSaving by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    val isDirty: Boolean get() = draft != savedDraft

    val hasFiles: Boolean
        get() {
            val b = bot ?: return false
            val a = access ?: return false
            val c = catalog ?: return false
            if (b.health == AidenBotHealth.UNAVAILABLE) return false
            return AidenBotChatAccessPresentation.hasFiles(b.access, a, c)
        }

    fun summary(connected: Boolean): String {
        val b = bot
        val a = access
        if (b == null || a == null) return if (isLoading) "Loading access…" else "Access unavailable"
        return AidenBotChatAccessPresentation.summary(b, a, connected)
    }

    fun canEdit(hostAllowsMutations: Boolean, connected: Boolean, canWriteBots: Boolean): Boolean {
        if (!isDirty || !allowsDraftEditing(hostAllowsMutations, connected, canWriteBots)) return false
        val b = bot ?: return false
        val a = access ?: return false
        val c = catalog ?: return false
        val d = draft ?: return false
        return b.health == AidenBotHealth.READY &&
                a.botPolicyRevision == b.access.revision &&
                d.isSaveable(b.access, c)
    }

    fun allowsDraftEditing(hostAllowsMutations: Boolean, connected: Boolean, canWriteBots: Boolean): Boolean {
        return hostAllowsMutations && !isLoading && !isSaving && connected && canWriteBots &&
                bot?.health == AidenBotHealth.READY
    }

    fun readOnlyMessage(connected: Boolean, canWriteBots: Boolean, hostAllowsMutations: Boolean): String? {
        if (bot?.health == AidenBotHealth.ARCHIVED) return "Archived bots are read-only until restored."
        if (bot?.health == AidenBotHealth.DEGRADED || bot?.health == AidenBotHealth.UNAVAILABLE) {
            return "This bot's access needs repair on your paired desktop before it can work."
        }
        if (!connected) return "Offline — reconnect to change this chat's access."
        if (!canWriteBots) return "This phone can view Bot access but is not approved to change it."
        if (!hostAllowsMutations) return "This conversation is read-only right now."
        return null
    }

    fun fileGrant(connected: Boolean, canWriteBots: Boolean, hostAllowsMutations: Boolean): AidenBotConversationFileGrant? {
        if (!hasFiles) return null
        val b = bot ?: return null
        val a = access ?: return null
        val c = catalog ?: return null
        return AidenBotConversationFileGrant(
            chatID = chatID,
            botID = botID,
            chatAccessRevision = a.revision,
            botPolicyRevision = b.access.revision,
            catalogRevision = c.revision,
            allowsWrites = hostAllowsMutations && b.health == AidenBotHealth.READY &&
                    connected && canWriteBots
        )
    }

    suspend fun load(client: AidenRemoteClient) {
        isLoading = true
        errorMessage = null
        try {
            val loadedBot = client.bot(botID)
            val loadedAccess = client.botChatAccess(chatID)
            val loadedCatalog = client.botCapabilityCatalog(botID)
            val loadedDraft = AidenBotChatAccessDraft.create(loadedBot.access, loadedAccess, loadedCatalog)

            bot = loadedBot
            access = loadedAccess
            catalog = loadedCatalog
            draft = loadedDraft
            savedDraft = loadedDraft
        } catch (e: Exception) {
            if (e !is CancellationException) {
                errorMessage = e.localizedMessage
            }
        } finally {
            isLoading = false
        }
    }

    suspend fun save(client: AidenRemoteClient, hostAllowsMutations: Boolean, connected: Boolean, canWriteBots: Boolean): Boolean {
        if (!canEdit(hostAllowsMutations, connected, canWriteBots)) return false
        val currentDraft = draft ?: return false
        val currentAccess = access ?: return false
        val currentBot = bot ?: return false
        val currentCatalog = catalog ?: return false

        isSaving = true
        errorMessage = null
        return try {
            val update = when (currentDraft.mode) {
                AidenBotChatAccessMode.INHERIT -> AidenBotChatAccessUpdate(
                    mode = AidenBotChatAccessMode.INHERIT,
                    catalogRevision = currentCatalog.revision,
                    expectedBotPolicyRevision = currentBot.access.revision
                )
                AidenBotChatAccessMode.CUSTOM -> {
                    val selection = currentDraft.selection()
                    AidenBotChatAccessUpdate(
                        mode = AidenBotChatAccessMode.CUSTOM,
                        catalogRevision = currentCatalog.revision,
                        expectedBotPolicyRevision = currentBot.access.revision,
                        custom = selection
                    )
                }
            }
            val updated = client.updateBotChatAccess(chatID, currentAccess.revision, update)
            val nextDraft = AidenBotChatAccessDraft.create(currentBot.access, updated, currentCatalog)
            access = updated
            draft = nextDraft
            savedDraft = nextDraft
            true
        } catch (e: Exception) {
            if (e !is CancellationException) {
                errorMessage = e.localizedMessage
            }
            false
        } finally {
            isSaving = false
        }
    }
}

class AidenBotConversationFilesModel(
    val grant: AidenBotConversationFileGrant
) {
    var index by mutableStateOf<AidenWorkspaceFileIndex?>(null)
    var document by mutableStateOf<AidenWorkspaceFileDocument?>(null)
    var draft by mutableStateOf("")
    var isLoading by mutableStateOf(false)
    var isSaving by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    suspend fun load(client: AidenRemoteClient) {
        isLoading = true
        errorMessage = null
        try {
            val files = client.botConversationFiles(grant.chatID)
            index = files
        } catch (e: Exception) {
            if (e !is CancellationException) {
                errorMessage = e.localizedMessage
            }
        } finally {
            isLoading = false
        }
    }

    suspend fun open(entry: AidenWorkspaceFileEntry, client: AidenRemoteClient): Boolean {
        if (entry.kind != AidenWorkspaceFileKind.FILE) return false
        errorMessage = null
        return try {
            val doc = client.botConversationFile(grant.chatID, entry.id)
            document = doc
            draft = doc.content
            true
        } catch (e: Exception) {
            if (e !is CancellationException) {
                errorMessage = e.localizedMessage
            }
            false
        }
    }

    suspend fun save(client: AidenRemoteClient): Boolean {
        val currentDoc = document ?: return false
        if (!grant.allowsWrites) return false
        isSaving = true
        errorMessage = null
        return try {
            val saved = client.writeBotConversationFile(
                chatId = grant.chatID,
                fileId = currentDoc.id,
                content = draft,
                expectedVersion = currentDoc.version
            )
            document = saved
            draft = saved.content
            true
        } catch (e: Exception) {
            if (e !is CancellationException) {
                errorMessage = e.localizedMessage
            }
            false
        } finally {
            isSaving = false
        }
    }
}

@Composable
fun AidenBotChatToolsBar(
    bot: AidenBotSummary?,
    model: AidenBotChatToolsModel? = null,
    connected: Boolean = true,
    onOpenAccess: () -> Unit,
    onOpenProfile: () -> Unit,
    onOpenFiles: (() -> Unit)? = null
) {
    val palette = AidenTheme.palette

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        colors = CardDefaults.cardColors(containerColor = palette.raised),
        shape = RoundedCornerShape(12.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Icon(Icons.Default.SmartToy, contentDescription = null, tint = palette.accent)
            Spacer(modifier = Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = bot?.name ?: "Bot",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground
                )
                model?.let { m ->
                    Text(
                        text = m.summary(connected),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary,
                        fontSize = 11.sp
                    )
                }
            }

            if (model?.hasFiles == true && onOpenFiles != null) {
                IconButton(onClick = onOpenFiles) {
                    Icon(Icons.Default.Folder, contentDescription = "Files", tint = palette.secondary)
                }
            }

            IconButton(onClick = onOpenAccess) {
                Icon(Icons.Default.Shield, contentDescription = "Access", tint = palette.secondary)
            }
            IconButton(onClick = onOpenProfile) {
                Icon(Icons.Default.Info, contentDescription = "Profile", tint = palette.secondary)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotChatAccessSheet(
    model: AidenBotChatToolsModel,
    client: AidenRemoteClient?,
    connected: Boolean,
    canWriteBots: Boolean,
    hostAllowsMutations: Boolean,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val coroutineScope = rememberCoroutineScope()
    var selectedScope by remember { mutableStateOf(AidenBotChatAccessScope.CHAT) }

    LaunchedEffect(model.chatID) {
        if (client != null) {
            model.load(client)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = palette.canvas,
        dragHandle = null,
        sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "Access",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = palette.foreground,
                    modifier = Modifier.weight(1f)
                )
                if (selectedScope == AidenBotChatAccessScope.CHAT) {
                    Button(
                        onClick = {
                            if (client != null) {
                                coroutineScope.launch {
                                    if (model.save(client, hostAllowsMutations, connected, canWriteBots)) {
                                        onDismiss()
                                    }
                                }
                            }
                        },
                        enabled = model.canEdit(hostAllowsMutations, connected, canWriteBots) && !model.isSaving,
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        Text(if (model.isSaving) "Saving…" else "Save", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Scope Selector
            Row(modifier = Modifier.fillMaxWidth()) {
                FilterChip(
                    border = null,
                    selected = selectedScope == AidenBotChatAccessScope.CHAT,
                    onClick = { selectedScope = AidenBotChatAccessScope.CHAT },
                    label = { Text("This chat") },
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(8.dp))
                FilterChip(
                    border = null,
                    selected = selectedScope == AidenBotChatAccessScope.BOT,
                    onClick = { selectedScope = AidenBotChatAccessScope.BOT },
                    label = { Text("Bot defaults") },
                    modifier = Modifier.weight(1f)
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            if (selectedScope == AidenBotChatAccessScope.BOT) {
                // Effective Bot Access
                model.bot?.let { b ->
                    Card(
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text("Effective bot access", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.foreground)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(b.access.summary, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                        }
                    }
                }
            } else {
                // Chat Access settings
                val currentDraft = model.draft
                val canEdit = model.allowsDraftEditing(hostAllowsMutations, connected, canWriteBots)

                if (currentDraft != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Mode:", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                        Spacer(modifier = Modifier.width(12.dp))
                        FilterChip(
                            border = null,
                            selected = currentDraft.mode == AidenBotChatAccessMode.INHERIT,
                            onClick = { if (canEdit) model.draft = currentDraft.copy(mode = AidenBotChatAccessMode.INHERIT) },
                            label = { Text("Inherit Bot") }
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        FilterChip(
                            border = null,
                            selected = currentDraft.mode == AidenBotChatAccessMode.CUSTOM,
                            onClick = { if (canEdit) model.draft = currentDraft.copy(mode = AidenBotChatAccessMode.CUSTOM) },
                            label = { Text("Customize") }
                        )
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    if (currentDraft.mode == AidenBotChatAccessMode.CUSTOM) {
                        model.catalog?.let { cat ->
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .verticalScroll(rememberScrollState())
                            ) {
                                // Commands
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text("Run commands", style = MaterialTheme.typography.bodyMedium, color = palette.foreground, modifier = Modifier.weight(1f))
                                    Switch(
                                        checked = currentDraft.shellEnabled,
                                        onCheckedChange = { if (canEdit) model.draft = currentDraft.copy(shellEnabled = it) },
                                        enabled = canEdit && cat.shellAvailable
                                    )
                                }

                                // Skills
                                if (cat.skills.isNotEmpty()) {
                                    Spacer(modifier = Modifier.height(12.dp))
                                    Text("Skills", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.foreground)
                                    for (skill in cat.skills) {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier.fillMaxWidth()
                                        ) {
                                            Text(skill.label, style = MaterialTheme.typography.bodySmall, color = palette.foreground, modifier = Modifier.weight(1f))
                                            Switch(
                                                checked = currentDraft.skillIDs.contains(skill.id),
                                                onCheckedChange = { checked ->
                                                    if (canEdit) {
                                                        val updated = if (checked) currentDraft.skillIDs + skill.id else currentDraft.skillIDs - skill.id
                                                        model.draft = currentDraft.copy(skillIDs = updated)
                                                    }
                                                },
                                                enabled = canEdit && skill.available
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            model.errorMessage?.let { err ->
                Spacer(modifier = Modifier.height(8.dp))
                Text(err, color = palette.danger, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}
