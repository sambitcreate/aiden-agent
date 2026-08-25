package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

fun aidenBotCustomAccessIsDirty(
    draft: AidenBotCustomAccessDraft?,
    cleanDraft: AidenBotCustomAccessDraft?
): Boolean {
    return draft != null && draft != cleanDraft
}

enum class AidenBotAccessSaveFailureKind {
    CONFLICT,
    RETRYABLE
}

fun aidenBotAccessSaveFailureKind(error: Throwable): AidenBotAccessSaveFailureKind {
    if (error is AidenRemoteClientException.Server) {
        if (error.statusCode == 409 && listOf("revision_conflict", "operation_stale").contains(error.body.code.rawValue.lowercase())) {
            return AidenBotAccessSaveFailureKind.CONFLICT
        }
    }
    return AidenBotAccessSaveFailureKind.RETRYABLE
}

fun aidenBotVisibleCapabilityOptions(
    options: List<AidenBotCapabilityOption>,
    selectedIDs: Set<String>
): List<AidenBotCapabilityOption> {
    return options.filter { it.available || selectedIDs.contains(it.id) }
}

fun aidenBotVisibleFileScopeOptions(
    options: List<AidenBotFileScopeOption>,
    selectedIDs: Set<String>
): List<AidenBotFileScopeOption> {
    return options.filter { it.available || selectedIDs.contains(it.id) }
}

fun aidenBotCapabilityOptionTitle(
    option: AidenBotCapabilityOption,
    isSelected: Boolean
): String {
    if (option.available) return option.label
    if (isSelected && option.label == "Invalid skill") {
        return "Previously selected skill — unavailable"
    }
    return "${option.label} — Unavailable"
}

fun aidenBotFileScopeOptionTitle(
    option: AidenBotFileScopeOption,
    isSelected: Boolean
): String {
    if (option.available) return option.label
    return "${option.label} — Unavailable"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotCustomAccessFlowScreen(
    botId: String? = null,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onAccessSaved: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsState()

    var bots by remember { mutableStateOf<List<AidenBotSummary>>(emptyList()) }
    var selectedBotId by remember { mutableStateOf(botId) }
    var selectedBotDetail by remember { mutableStateOf<AidenBotDetail?>(null) }
    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    var draft by remember { mutableStateOf<AidenBotCustomAccessDraft?>(null) }
    var cleanDraft by remember { mutableStateOf<AidenBotCustomAccessDraft?>(null) }

    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var isConfirmingDiscard by remember { mutableStateOf(false) }
    var pendingBotSwitchId by remember { mutableStateOf<String?>(null) }

    val isDirty = aidenBotCustomAccessIsDirty(draft, cleanDraft)

    fun loadBot(targetBotId: String) {
        val cl = client ?: return
        scope.launch {
            try {
                val bot = cl.bot(targetBotId)
                val cat = cl.botCapabilityCatalog(targetBotId)
                selectedBotDetail = bot
                catalog = cat
                val d = AidenBotCustomAccessDraft.fromAccess(bot.access, cat)
                draft = d
                cleanDraft = d?.copy()
            } catch (e: Exception) {
                saveError = e.message
            }
        }
    }

    LaunchedEffect(client) {
        val cl = client ?: return@LaunchedEffect
        isLoading = true
        try {
            val list = cl.bots()
            bots = list.bots.filter { it.health != AidenBotHealth.ARCHIVED }
            val currentId = selectedBotId ?: bots.firstOrNull()?.id
            selectedBotId = currentId
            if (currentId != null) {
                loadBot(currentId)
            }
        } catch (e: Exception) {
            saveError = e.message
        } finally {
            isLoading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Custom Access", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = {
                        if (isDirty) {
                            pendingBotSwitchId = null
                            isConfirmingDiscard = true
                        } else {
                            onNavigateBack()
                        }
                    }) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
                    }
                },
                actions = {
                    TextButton(
                        onClick = {
                            val curDraft = draft ?: return@TextButton
                            val cat = catalog ?: return@TextButton
                            val detail = selectedBotDetail ?: return@TextButton
                            val cl = client ?: return@TextButton
                            if (!curDraft.isSaveable(cat) || isSaving) return@TextButton

                            scope.launch {
                                isSaving = true
                                saveError = null
                                try {
                                    val sel = curDraft.selection()
                                    val update = AidenBotAccessUpdate.custom(cat.revision, sel)
                                    cl.updateBotAccess(detail.id, detail.access.revision, update)
                                    onAccessSaved()
                                } catch (e: Exception) {
                                    val failureKind = aidenBotAccessSaveFailureKind(e)
                                    if (failureKind == AidenBotAccessSaveFailureKind.CONFLICT) {
                                        // Refresh authoritative data
                                        try {
                                            val fresh = cl.bot(detail.id)
                                            val freshCat = cl.botCapabilityCatalog(detail.id)
                                            selectedBotDetail = fresh
                                            catalog = freshCat
                                            saveError = "Access policy was changed on your Mac. Review the latest policy and try again."
                                        } catch (_: Exception) {
                                            saveError = e.message ?: "Conflict updating access"
                                        }
                                    } else {
                                        saveError = e.message ?: "Failed to save access policy"
                                    }
                                } finally {
                                    isSaving = false
                                }
                            }
                        },
                        enabled = draft?.let { d -> catalog?.let { c -> d.isSaveable(c) } } == true && !isSaving
                    ) {
                        Text(if (isSaving) "Saving…" else "Save", color = if (draft?.let { d -> catalog?.let { c -> d.isSaveable(c) } } == true) palette.accent else palette.secondary, fontWeight = FontWeight.Bold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
            )
        },
        containerColor = palette.canvas
    ) { padding ->
        val curDraft = draft
        val cat = catalog

        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = palette.accent)
            }
        } else if (curDraft != null && cat != null) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 20.dp),
                contentPadding = PaddingValues(vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Bot Switcher Picker Row
                if (bots.size > 1) {
                    item {
                        Text("Select Bot", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                        Spacer(modifier = Modifier.height(6.dp))
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(bots) { b ->
                                FilterChip(
                                    border = null,
                                    selected = selectedBotId == b.id,
                                    onClick = {
                                        if (selectedBotId != b.id) {
                                            if (isDirty) {
                                                pendingBotSwitchId = b.id
                                                isConfirmingDiscard = true
                                            } else {
                                                selectedBotId = b.id
                                                loadBot(b.id)
                                            }
                                        }
                                    },
                                    label = { Text(b.name) }
                                )
                            }
                        }
                    }
                }

                // AI Model Provider / Model section
                item {
                    Text("AI Model", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                    Spacer(modifier = Modifier.height(6.dp))
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            cat.providers.forEach { provider ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    AidenProviderIcon(providerId = provider.id, providerLabel = provider.label, size = 22.dp)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(provider.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                                }
                                provider.models.forEach { model ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .clickable {
                                                draft = curDraft.copy(
                                                    providerID = provider.id,
                                                    modelID = model.id
                                                )
                                            }
                                            .padding(horizontal = 8.dp, vertical = 6.dp)
                                    ) {
                                        RadioButton(
                                            selected = curDraft.providerID == provider.id && curDraft.modelID == model.id,
                                            onClick = {
                                                draft = curDraft.copy(
                                                    providerID = provider.id,
                                                    modelID = model.id
                                                )
                                            },
                                            colors = RadioButtonDefaults.colors(selectedColor = palette.accent)
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(model.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                                        if (!model.available) {
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Text("(Unavailable)", style = MaterialTheme.typography.labelSmall, color = palette.danger)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // File Scopes Section
                item {
                    Text("Mac Files", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                    Spacer(modifier = Modifier.height(6.dp))
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            val visibleScopes = aidenBotVisibleFileScopeOptions(cat.fileScopes, curDraft.fileScopeIDs)
                            visibleScopes.forEach { scopeItem ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable {
                                            val next = if (curDraft.fileScopeIDs.contains(scopeItem.id))
                                                curDraft.fileScopeIDs - scopeItem.id
                                            else
                                                curDraft.fileScopeIDs + scopeItem.id
                                            draft = curDraft.copy(fileScopeIDs = next)
                                        }
                                        .padding(horizontal = 6.dp, vertical = 6.dp)
                                ) {
                                    Checkbox(
                                        checked = curDraft.fileScopeIDs.contains(scopeItem.id),
                                        onCheckedChange = { checked ->
                                            val next = if (checked) curDraft.fileScopeIDs + scopeItem.id else curDraft.fileScopeIDs - scopeItem.id
                                            draft = curDraft.copy(fileScopeIDs = next)
                                        },
                                        colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            text = aidenBotFileScopeOptionTitle(scopeItem, curDraft.fileScopeIDs.contains(scopeItem.id)),
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.SemiBold,
                                            color = palette.foreground
                                        )
                                        scopeItem.description?.let {
                                            Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Terminal Shell section
                item {
                    Text("Terminal & Shell", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                    Spacer(modifier = Modifier.height(6.dp))
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(16.dp)
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Execute Shell Commands", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                                Text("Allows bot to run terminal commands on Mac", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                            }
                            Switch(
                                checked = curDraft.shellEnabled,
                                onCheckedChange = { draft = curDraft.copy(shellEnabled = it) },
                                enabled = cat.shellAvailable,
                                colors = SwitchDefaults.colors(checkedTrackColor = palette.accent)
                            )
                        }
                    }
                }

                // MCP Connections section
                if (cat.connections.isNotEmpty()) {
                    item {
                        Text("MCP Connections", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                        Spacer(modifier = Modifier.height(6.dp))
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                val visibleConnections = aidenBotVisibleCapabilityOptions(cat.connections, curDraft.connectionIDs)
                                visibleConnections.forEach { conn ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .clickable {
                                                val next = if (curDraft.connectionIDs.contains(conn.id))
                                                    curDraft.connectionIDs - conn.id
                                                else
                                                    curDraft.connectionIDs + conn.id
                                                draft = curDraft.copy(connectionIDs = next)
                                            }
                                            .padding(horizontal = 6.dp, vertical = 6.dp)
                                    ) {
                                        Checkbox(
                                            checked = curDraft.connectionIDs.contains(conn.id),
                                            onCheckedChange = { checked ->
                                                val next = if (checked) curDraft.connectionIDs + conn.id else curDraft.connectionIDs - conn.id
                                                draft = curDraft.copy(connectionIDs = next)
                                            },
                                            colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(
                                            text = aidenBotCapabilityOptionTitle(conn, curDraft.connectionIDs.contains(conn.id)),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = palette.foreground
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                // Skills section
                if (cat.skills.isNotEmpty()) {
                    item {
                        Text("Skills", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                        Spacer(modifier = Modifier.height(6.dp))
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                val visibleSkills = aidenBotVisibleCapabilityOptions(cat.skills, curDraft.skillIDs)
                                visibleSkills.forEach { skill ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .clickable {
                                                val next = if (curDraft.skillIDs.contains(skill.id))
                                                    curDraft.skillIDs - skill.id
                                                else
                                                    curDraft.skillIDs + skill.id
                                                draft = curDraft.copy(skillIDs = next)
                                            }
                                            .padding(horizontal = 6.dp, vertical = 6.dp)
                                    ) {
                                        Checkbox(
                                            checked = curDraft.skillIDs.contains(skill.id),
                                            onCheckedChange = { checked ->
                                                val next = if (checked) curDraft.skillIDs + skill.id else curDraft.skillIDs - skill.id
                                                draft = curDraft.copy(skillIDs = next)
                                            },
                                            colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(
                                            text = aidenBotCapabilityOptionTitle(skill, curDraft.skillIDs.contains(skill.id)),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = palette.foreground
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                // Other capabilities section
                if (cat.otherCapabilities.isNotEmpty()) {
                    item {
                        Text("Other Capabilities", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)
                        Spacer(modifier = Modifier.height(6.dp))
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                val visibleOthers = aidenBotVisibleCapabilityOptions(cat.otherCapabilities, curDraft.otherCapabilityIDs)
                                visibleOthers.forEach { cap ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .clickable {
                                                val next = if (curDraft.otherCapabilityIDs.contains(cap.id))
                                                    curDraft.otherCapabilityIDs - cap.id
                                                else
                                                    curDraft.otherCapabilityIDs + cap.id
                                                draft = curDraft.copy(otherCapabilityIDs = next)
                                            }
                                            .padding(horizontal = 6.dp, vertical = 6.dp)
                                    ) {
                                        Checkbox(
                                            checked = curDraft.otherCapabilityIDs.contains(cap.id),
                                            onCheckedChange = { checked ->
                                                val next = if (checked) curDraft.otherCapabilityIDs + cap.id else curDraft.otherCapabilityIDs - cap.id
                                                draft = curDraft.copy(otherCapabilityIDs = next)
                                            },
                                            colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(
                                            text = aidenBotCapabilityOptionTitle(cap, curDraft.otherCapabilityIDs.contains(cap.id)),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = palette.foreground
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                saveError?.let { err ->
                    item {
                        Text(err, color = palette.danger, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }

    if (isConfirmingDiscard) {
        AlertDialog(
            onDismissRequest = { isConfirmingDiscard = false },
            title = { Text("Discard access changes?") },
            text = { Text("Your unsaved Custom Access changes will be lost.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        isConfirmingDiscard = false
                        val nextId = pendingBotSwitchId
                        if (nextId != null) {
                            selectedBotId = nextId
                            loadBot(nextId)
                        } else {
                            onNavigateBack()
                        }
                    }
                ) {
                    Text("Discard Changes", color = palette.danger, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { isConfirmingDiscard = false }) {
                    Text("Keep Editing", color = palette.secondary)
                }
            },
            containerColor = palette.raised
        )
    }
}
