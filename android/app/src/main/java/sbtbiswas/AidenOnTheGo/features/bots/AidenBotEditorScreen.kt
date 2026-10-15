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
import androidx.annotation.StringRes
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
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

    /**
     * Records how [attempt] ended: only an uncertain failure stays replayable. A try that never
     * reached the Mac (it stayed unreachable) changes nothing, so a try before it that may have
     * made the Bot is still the one replayed.
     */
    fun failed(attempt: AidenBotCreateAttempt, error: Throwable) {
        if (error is AidenBotChatActivityUnreachable) return
        uncertain = if (aidenScheduledRunFailureIsAmbiguous(error)) attempt else null
    }

    /** The Mac made [attempt]'s Bot: another Create with the same answers is another Bot. */
    fun succeeded(attempt: AidenBotCreateAttempt) {
        if (uncertain === attempt) uncertain = null
    }
}

/**
 * Bot creation that never waits on New Bot (R15, as on iOS). Create closes the form at once and
 * Bots home shows the Bot as on its way ([pending]); it goes out once the Mac is connected (up
 * to [holdMillis]) and within [limitMillis]. A failure takes the row away and leaves a
 * [failure] whose Try again ([retry]) reopens New Bot with the same answers. The same answers
 * replay the frozen attempt, request and Idempotency-Key alike, even after the Mac's catalog
 * moved on, so a retry never makes two Bots. One Bot is made at a time.
 */
class AidenBotCreateFlow(
    private val waitForConnection: (suspend () -> Boolean)?,
    private val create: suspend (AidenBotCreateRequest, UUID) -> AidenBotDetail,
    /** The Mac's new Bot, kept for every screen. */
    private val cache: (AidenBotDetail) -> Unit,
    private val attempts: AidenBotCreateAttempts = AidenBotCreateAttempts(),
    private val holdMillis: Long = AIDEN_BOT_SAVE_HOLD_MILLIS,
    private val limitMillis: Long = AIDEN_BOT_SAVE_LIMIT_MILLIS
) {
    /** A Bot on its way to the Mac: Bots home shows its name and "Creating…". */
    data class Pending(val name: String)

    /** Why the last Create didn't make a Bot, and the answers Try again brings back. */
    data class Failure(@StringRes val message: Int, val draft: AidenBotCreateDraft)

    private val _pending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = _pending.asStateFlow()

    private val _failure = MutableStateFlow<Failure?>(null)
    val failure: StateFlow<Failure?> = _failure.asStateFlow()

    private val _created = MutableSharedFlow<AidenBotDetail>(extraBufferCapacity = 1)
    /** Each Bot this flow made, as the Mac made it, to whoever is listening then. */
    val created: SharedFlow<AidenBotDetail> = _created.asSharedFlow()

    private var prefill: AidenBotCreateDraft? = null

    /** True when [draft] would replay a try that may have reached the Mac. */
    fun replays(draft: AidenBotCreateDraft): Boolean = attempts.replays(draft)

    /**
     * Shows [draft]'s Bot as on its way and returns the attempt for [send], or null when another
     * Create is still on its way or no request can be built. [catalog] is the form's; it only
     * shapes a new request, never a replayed one.
     */
    fun start(draft: AidenBotCreateDraft, catalog: AidenBotCapabilityCatalog?): AidenBotCreateAttempt? {
        if (_pending.value != null) return null
        val attempt = attempts.begin(draft, catalog) ?: return null
        _failure.value = null
        _pending.value = Pending(attempt.request.name)
        return attempt
    }

    /** Makes [attempt]'s Bot. Run it where it outlives the form; it settles [pending] either way. */
    suspend fun send(attempt: AidenBotCreateAttempt) {
        try {
            val made = aidenBotHeldRequest(waitForConnection, holdMillis, limitMillis) { create(attempt.request, attempt.key) }
            attempts.succeeded(attempt)
            cache(made)
            _pending.value = null
            _created.tryEmit(made)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            attempts.failed(attempt, error)
            _pending.value = null
            val message = if (aidenBotChatActivityMacUnreachable(error)) R.string.bot_editor_create_unreachable else R.string.bot_editor_create_failed
            _failure.value = Failure(message, attempt.draft)
        } finally {
            // A pairing change cancels it: nothing is on its way any more.
            _pending.value = null
        }
    }

    /** Try again: New Bot opens with the failed answers ([takePrefill]). */
    fun retry() {
        prefill = _failure.value?.draft
        _failure.value = null
    }

    /** OK: the failure is gone, and New Bot opens empty next time. */
    fun dismissFailure() {
        prefill = null
        _failure.value = null
    }

    /** What New Bot opens with, once. */
    fun takePrefill(): AidenBotCreateDraft? = prefill.also { prefill = null }
}

/** The Bot create flow for the pairing in use: its Bots are made on, and kept for, that pairing only. */
fun AidenRemoteCoordinator.botCreateFlow(): AidenBotCreateFlow = pairingMemo("bot-create-flow") {
    val host = botSaveHost()
    AidenBotCreateFlow(
        waitForConnection = host.waitForConnection,
        create = { request, key -> host.connected().createBot(request, key) },
        cache = host.cache
    )
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
        AidenBotCreateScreen(coordinator, onNavigateBack)
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
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val client by coordinator.client.collectAsStateWithLifecycle()
    // Create closes New Bot at once and Bots home shows the Bot on its way (R15). The flow and
    // the save host outlive the form, so a retry keeps its answers and its idempotency key.
    val flow = remember(client) { coordinator.botCreateFlow() }
    val saveHost = remember(client) { coordinator.botSaveHost() }
    var draft by remember { mutableStateOf(flow.takePrefill() ?: AidenBotCreateDraft()) }
    val pending by flow.pending.collectAsStateWithLifecycle()
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

    AidenBotEditorScaffold(
        title = stringResource(R.string.bot_editor_new_title),
        // Another Bot still on its way holds this one until it lands.
        actionLabel = if (pending != null) stringResource(R.string.bot_editor_creating) else stringResource(R.string.action_create),
        actionEnabled = pending == null && (flow.replays(draft) || draft.request(catalog) != null),
        onNavigateBack = onNavigateBack,
        onAction = {
            val attempt = flow.start(draft, catalog) ?: return@AidenBotEditorScaffold
            saveHost.launch { flow.send(attempt) }
            onNavigateBack()
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
