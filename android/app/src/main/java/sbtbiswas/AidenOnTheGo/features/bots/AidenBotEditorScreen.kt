package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.util.UUID

const val AIDEN_BOT_DEFAULT_INSTRUCTIONS = "Help clearly, use the selected tools when useful, and keep me in control."

/** The one-line subtitle a Bot shows under its name, taken from "What should it help with?". */
fun aidenBotSubtitle(help: String): String {
    val firstLine = help.trim().lineSequence().firstOrNull()?.trim().orEmpty()
    if (firstLine.codePointCount(0, firstLine.length) <= AidenBotWire.MAX_PURPOSE_LENGTH) return firstLine
    return firstLine.substring(0, firstLine.offsetByCodePoints(0, AidenBotWire.MAX_PURPOSE_LENGTH)).trimEnd()
}

/** The two answers the create flow asks for. */
data class AidenBotCreateDraft(
    val name: String = "",
    val help: String = ""
) {
    val canCreate: Boolean
        get() = name.isNotBlank()

    /**
     * The create request for this draft. The answer becomes the subtitle and seeds the
     * instructions; the character is picked from the name. Access is omitted, which the
     * Mac treats as Full; a Bot made before any AI model is ready reports `needs_model`.
     */
    fun request(): AidenBotCreateRequest? {
        if (!canCreate) return null
        val trimmedName = name.trim().take(AidenBotWire.MAX_NAME_LENGTH)
        return AidenBotCreateRequest(
            name = trimmedName,
            purpose = aidenBotSubtitle(help),
            instructions = help.trim().take(AidenBotWire.MAX_INSTRUCTIONS_LENGTH).ifEmpty { AIDEN_BOT_DEFAULT_INSTRUCTIONS },
            avatar = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.autoAssigned(trimmedName))
        )
    }
}

/**
 * The Bot editor route. With no [botId] it is the two-question create flow; with a
 * [botId] it is the full-screen Instructions editor, where Save persists and Back discards.
 */
@Composable
fun AidenBotEditorScreen(
    botId: String? = null,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onBotSaved: (String) -> Unit
) {
    if (botId == null) {
        AidenBotCreateScreen(coordinator, onNavigateBack, onBotSaved)
    } else {
        AidenBotInstructionsEditorScreen(botId, coordinator, onNavigateBack, onBotSaved)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AidenBotEditorScaffold(
    title: String,
    actionLabel: String,
    actionEnabled: Boolean,
    onAction: () -> Unit,
    onNavigateBack: () -> Unit,
    content: @Composable ColumnScope.() -> Unit
) {
    val palette = AidenTheme.palette
    Scaffold(
        containerColor = palette.canvas,
        topBar = {
            TopAppBar(
                title = { Text(title, fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                    }
                },
                actions = {
                    AidenPrimaryButton(
                        text = actionLabel,
                        enabled = actionEnabled,
                        onClick = onAction,
                        modifier = Modifier.padding(end = 12.dp)
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .aidenReadableWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            content = content
        )
    }
}

@Composable
private fun AidenBotCreateScreen(
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onBotSaved: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    var draft by remember { mutableStateOf(AidenBotCreateDraft()) }
    var isSaving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // One key per attempt, so a retried Create never makes two Bots.
    val botKey = remember { UUID.randomUUID() }

    AidenBotEditorScaffold(
        title = stringResource(R.string.bot_editor_new_title),
        actionLabel = if (isSaving) stringResource(R.string.bot_editor_creating) else stringResource(R.string.action_create),
        actionEnabled = !isSaving && client != null && draft.request() != null,
        onNavigateBack = onNavigateBack,
        onAction = {
            val cl = client ?: return@AidenBotEditorScaffold
            val request = draft.request() ?: return@AidenBotEditorScaffold
            scope.launch {
                isSaving = true
                error = null
                try {
                    val created = cl.createBot(request, botKey)
                    coordinator.botCache.putBotDetail(created)
                    onBotSaved(created.id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    error = resources.getString(R.string.bot_editor_create_failed)
                } finally {
                    isSaving = false
                }
            }
        }
    ) {
        AidenBotSemanticAvatarView(
            avatar = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.autoAssigned(draft.name)),
            name = draft.name,
            size = 96.dp,
            modifier = Modifier.align(Alignment.CenterHorizontally)
        )
        AidenBotLabeledField(
            label = stringResource(R.string.bot_field_name),
            value = draft.name,
            onValueChange = { draft = draft.copy(name = it.take(AidenBotWire.MAX_NAME_LENGTH)) },
            placeholder = stringResource(R.string.bot_editor_name_placeholder),
            singleLine = true
        )
        AidenBotLabeledField(
            label = stringResource(R.string.bot_editor_help_label),
            value = draft.help,
            onValueChange = { draft = draft.copy(help = it.take(AidenBotWire.MAX_INSTRUCTIONS_LENGTH)) },
            placeholder = stringResource(R.string.bot_editor_help_placeholder),
            singleLine = false
        )
        Text(
            text = stringResource(R.string.bot_editor_later_hint),
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
        error?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun AidenBotInstructionsEditorScreen(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onBotSaved: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsStateWithLifecycle()
    var bot by remember { mutableStateOf<AidenBotDetail?>(coordinator.botCache.getBotDetail(botId)) }
    var text by remember { mutableStateOf(bot?.instructions.orEmpty()) }
    var loaded by remember { mutableStateOf(bot != null) }
    var isSaving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(botId, client) {
        val cl = client ?: return@LaunchedEffect
        // The pairing this read belongs to; a removed or switched pairing never gets it back.
        val requestInstance = coordinator.activeInstanceId
        try {
            val fresh = cl.bot(botId)
            if (!coordinator.holdsReadAuthority(cl, requestInstance)) return@LaunchedEffect
            // Keep what the person already typed; only fill an untouched editor.
            if (!loaded || text == bot?.instructions) text = fresh.instructions
            bot = fresh
            loaded = true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (!loaded) error = resources.getString(R.string.bot_editor_instructions_load_failed)
        }
    }

    val current = bot
    val trimmed = text.trim()
    AidenBotEditorScaffold(
        title = stringResource(R.string.bot_profile_instructions),
        actionLabel = if (isSaving) stringResource(R.string.action_saving) else stringResource(R.string.action_save),
        actionEnabled = !isSaving && current != null && trimmed.isNotEmpty(),
        onNavigateBack = onNavigateBack,
        onAction = {
            val cl = client ?: return@AidenBotEditorScaffold
            val b = current ?: return@AidenBotEditorScaffold
            if (trimmed == b.instructions) {
                onBotSaved(b.id)
                return@AidenBotEditorScaffold
            }
            scope.launch {
                isSaving = true
                error = null
                try {
                    val saved = cl.updateBotIdentity(b.id, b.revision, AidenBotIdentityPatch(instructions = trimmed))
                    coordinator.botCache.putBotDetail(saved)
                    onBotSaved(saved.id)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    error = resources.getString(R.string.bot_save_failed)
                } finally {
                    isSaving = false
                }
            }
        }
    ) {
        TextField(
            value = text,
            onValueChange = { text = it.take(AidenBotWire.MAX_INSTRUCTIONS_LENGTH) },
            enabled = loaded,
            placeholder = { Text(stringResource(R.string.bot_editor_instructions_placeholder, current?.name ?: stringResource(R.string.bot_name_fallback_your_bot))) },
            colors = aidenTextFieldColors(),
            shape = MaterialTheme.shapes.large,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            minLines = 8,
            modifier = Modifier.fillMaxWidth()
        )
        error?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun AidenBotLabeledField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    singleLine: Boolean
) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = palette.secondary, modifier = Modifier.padding(horizontal = 4.dp))
        TextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text(placeholder) },
            singleLine = singleLine,
            minLines = if (singleLine) 1 else 3,
            colors = aidenTextFieldColors(),
            shape = MaterialTheme.shapes.large,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth()
        )
    }
}
