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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.scheduled.aidenScheduledRunFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerField
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
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

/** The answers the create flow asks for. */
data class AidenBotCreateDraft(
    val name: String = "",
    val help: String = "",
    /** Null keeps the Mac's recommended model (access omitted, Full). */
    val model: AidenModelRoute? = null
) {
    val canCreate: Boolean
        get() = name.isNotBlank()

    /** True when a model was chosen and the Mac's [catalog] no longer offers it as runnable. */
    fun modelIsGone(catalog: AidenBotCapabilityCatalog?): Boolean {
        val route = model ?: return false
        return catalog != null && !catalog.containsAvailable(route.providerId, route.modelId)
    }

    /**
     * The create request for this draft. The answer becomes the subtitle and seeds the
     * instructions; the character is picked from the name. With no [model] chosen, access
     * is omitted and the Mac uses Full access with its recommended model; a Bot made before
     * any AI model is ready reports `needs_model`. A chosen model is sent as Full access and
     * needs the [catalog] it came from; one the Mac can't run gives null.
     */
    fun request(catalog: AidenBotCapabilityCatalog? = null): AidenBotCreateRequest? {
        if (!canCreate) return null
        val access = model?.let { route ->
            val cat = catalog ?: return null
            if (!cat.containsAvailable(route.providerId, route.modelId)) return null
            AidenBotAccessUpdate.full(cat.revision, AidenBotModelSelection(providerId = route.providerId, modelId = route.modelId))
        }
        val trimmedName = name.trim().take(AidenBotWire.MAX_NAME_LENGTH)
        return AidenBotCreateRequest(
            name = trimmedName,
            purpose = aidenBotSubtitle(help),
            instructions = help.trim().take(AidenBotWire.MAX_INSTRUCTIONS_LENGTH).ifEmpty { AIDEN_BOT_DEFAULT_INSTRUCTIONS },
            avatar = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.autoAssigned(trimmedName)),
            access = access
        )
    }
}

/**
 * One Create as sent: the [request], its idempotency [key], and the [draft] it was built from.
 */
class AidenBotCreateAttempt internal constructor(
    val draft: AidenBotCreateDraft,
    val request: AidenBotCreateRequest,
    val key: UUID
)

/**
 * New Bot's idempotency keys. After an uncertain failure the Mac may already have made the
 * Bot, so the next Create replays that exact attempt (same request, same key) while the
 * person's draft is unchanged, even if the Mac's catalog has since moved or dropped the
 * model. A changed draft, or any attempt after a definite refusal, builds a new request
 * with a new key: the Mac keeps a refused key, replays its refusal for the same body and
 * answers a different body with `idempotency_conflict`.
 */
class AidenBotCreateAttempts(private val makeKey: () -> UUID = UUID::randomUUID) {
    private var uncertain: AidenBotCreateAttempt? = null

    /** True when the last Create failed uncertainly and [draft] is unchanged, so Create replays it. */
    fun replays(draft: AidenBotCreateDraft): Boolean = uncertain?.draft == draft

    /**
     * The attempt to send for [draft], or null when no request can be built from it. An
     * uncertain attempt for the same draft comes back unchanged; [catalog] only shapes a new one.
     */
    fun begin(draft: AidenBotCreateDraft, catalog: AidenBotCapabilityCatalog?): AidenBotCreateAttempt? {
        uncertain?.takeIf { it.draft == draft }?.let { return it }
        uncertain = null
        val request = draft.request(catalog) ?: return null
        return AidenBotCreateAttempt(draft, request, makeKey())
    }

    /** Records how [attempt] ended: only an uncertain failure stays replayable. */
    fun failed(attempt: AidenBotCreateAttempt, error: Throwable) {
        uncertain = if (aidenScheduledRunFailureIsAmbiguous(error)) attempt else null
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
    // The Mac's models; if they don't load the field is absent and Create sends no access.
    // Until the Mac answers (or while it connects) the field is a placeholder, never a spinner.
    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    var catalogSettled by remember { mutableStateOf(false) }
    LaunchedEffect(client) {
        val cl = client ?: return@LaunchedEffect
        // A failed refetch keeps the catalog already loaded.
        try {
            catalog = cl.botCapabilityCatalog()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        } finally {
            catalogSettled = true
        }
    }
    // Create never waits on the connection to be tapped: it waits for the Mac, then sends (R15).
    val saveHost = remember(client) { coordinator.botSaveHost() }
    // A retried Create never makes two Bots, and a changed one never reuses a refused key.
    val attempts = remember { AidenBotCreateAttempts() }

    AidenBotEditorScaffold(
        title = stringResource(R.string.bot_editor_new_title),
        actionLabel = if (isSaving) stringResource(R.string.bot_editor_creating) else stringResource(R.string.action_create),
        actionEnabled = !isSaving && (attempts.replays(draft) || draft.request(catalog) != null),
        onNavigateBack = onNavigateBack,
        onAction = {
            val attempt = attempts.begin(draft, catalog) ?: return@AidenBotEditorScaffold
            scope.launch {
                isSaving = true
                error = null
                try {
                    val created = aidenBotHeldRequest(saveHost.waitForConnection) { saveHost.connected().createBot(attempt.request, attempt.key) }
                    saveHost.cache(created)
                    onBotSaved(created.id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // No answer (offline, too slow) keeps the attempt, so Create replays its key.
                    attempts.failed(attempt, e)
                    // The Mac may have refused the model (its service was signed out); a fresh
                    // catalog lets the field say so instead of only the generic message.
                    try {
                        saveHost.client()?.let { catalog = it.botCapabilityCatalog() }
                    } catch (c: CancellationException) {
                        throw c
                    } catch (_: Exception) {
                    }
                    error = when {
                        draft.modelIsGone(catalog) -> null
                        aidenBotChatActivityMacUnreachable(e) -> resources.getString(R.string.bot_editor_create_unreachable)
                        else -> resources.getString(R.string.bot_editor_create_failed)
                    }
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
        if (catalog == null && !catalogSettled) {
            // The model field's place while the Mac's models arrive.
            val loading = stringResource(R.string.bot_advanced_loading)
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.clearAndSetSemantics { contentDescription = loading }
            ) {
                AidenSkeletonBlock(width = 96.dp, height = 12.dp)
                AidenSkeletonBlock(height = 56.dp, shape = MaterialTheme.shapes.large)
            }
        }
        catalog?.let { cat ->
            val providers = remember(cat) { aidenBotModelPickerProviders(cat) }
            val modelGone = draft.modelIsGone(cat)
            if (modelGone || providers.any { provider -> provider.models.any { it.available } }) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = stringResource(R.string.bot_advanced_model),
                        style = MaterialTheme.typography.labelLarge,
                        color = palette.secondary,
                        modifier = Modifier.padding(horizontal = 4.dp)
                    )
                    AidenModelPickerField(
                        title = stringResource(R.string.bot_advanced_model),
                        providers = providers,
                        selection = draft.model ?: aidenBotRecommendedModel(cat),
                        onSelect = { entry -> draft = draft.copy(model = entry.route) }
                    )
                    if (modelGone) {
                        Text(
                            text = stringResource(R.string.bot_editor_model_gone),
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.danger,
                            modifier = Modifier.padding(horizontal = 4.dp)
                        )
                    }
                }
            }
        }
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
    val client by coordinator.client.collectAsStateWithLifecycle()
    var bot by remember { mutableStateOf<AidenBotDetail?>(coordinator.botCache.getBotDetail(botId)) }
    var text by remember { mutableStateOf(bot?.instructions.orEmpty()) }
    var loaded by remember { mutableStateOf(bot != null) }
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
        actionLabel = stringResource(R.string.action_save),
        actionEnabled = current != null && trimmed.isNotEmpty(),
        onNavigateBack = onNavigateBack,
        onAction = {
            val b = current ?: return@AidenBotEditorScaffold
            if (trimmed == b.instructions) {
                onBotSaved(b.id)
                return@AidenBotEditorScaffold
            }
            // Saved at once (R15): Profile shows the new instructions now, the save runs on the
            // pairing's scope, and a failure puts them back and says so wherever the person is.
            val editor = coordinator.botIdentityEditor(b)
            coordinator.botSaveHost().launch {
                editor.edit(AidenBotIdentityPatch(instructions = trimmed))
                editor.state.value.failure?.let { coordinator.presentError(resources.getString(aidenBotSaveFailureText(it))) }
            }
            onBotSaved(b.id)
        }
    ) {
        if (!loaded && error == null) {
            // The instructions' place while they arrive, never a spinner.
            val loading = stringResource(R.string.bot_advanced_loading)
            AidenSkeletonBlock(
                height = 200.dp,
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.clearAndSetSemantics { contentDescription = loading }
            )
            return@AidenBotEditorScaffold
        }
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
