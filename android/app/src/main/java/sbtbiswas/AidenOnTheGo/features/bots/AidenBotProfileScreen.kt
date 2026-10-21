package sbtbiswas.AidenOnTheGo.features.bots

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.HideImage
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.SdStorage
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.res.pluralStringResource
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.shared.AidenReadPresentation
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth

/**
 * The patch that saves an inline name or subtitle edit, or null when nothing changed or
 * the name was cleared (a Bot always keeps a name).
 */
fun aidenBotIdentityTextPatch(bot: AidenBotDetail, name: String, subtitle: String): AidenBotIdentityPatch? {
    val nextName = name.trim().take(AidenBotWire.MAX_NAME_LENGTH)
    val nextSubtitle = aidenBotSubtitle(subtitle)
    val nameChanged = nextName.isNotEmpty() && nextName != bot.name
    val subtitleChanged = nextSubtitle != bot.purpose
    if (!nameChanged && !subtitleChanged) return null
    return AidenBotIdentityPatch(
        name = if (nameChanged) nextName else null,
        purpose = if (subtitleChanged) nextSubtitle else null
    )
}

/** Reads a picked Gallery photo, refusing anything larger than the normalizer accepts. */
private suspend fun aidenReadPickedPhoto(context: Context, uri: Uri): ByteArray = withContext(Dispatchers.IO) {
    val limit = AidenBotGeneratedAvatarNormalizer.MAX_SOURCE_BYTES
    context.contentResolver.openInputStream(uri)?.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            if (output.size() > limit) throw AidenBotGeneratedAvatarError.SourceTooLarge
        }
        output.toByteArray()
    } ?: throw AidenBotGeneratedAvatarError.InvalidImage
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotProfileScreen(
    botId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onNavigateToChat: (String) -> Unit,
    onNavigateToEditBot: (String) -> Unit,
    onNavigateToMemory: (String) -> Unit = {},
    onBotMutated: () -> Unit = {},
    botDeleter: AidenBotDeleter? = null,
    onBotDeleted: () -> Unit = onNavigateBack
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val client by coordinator.client.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()

    var bot by remember(botId) { mutableStateOf(coordinator.botCache.getBotDetail(botId)) }
    var isLoading by remember(botId) { mutableStateOf(false) }
    // Bumped by Try Again to rerun the read.
    var readAttempt by remember(botId) { mutableIntStateOf(0) }
    var loadFailed by remember(botId) { mutableStateOf(false) }
    var nameText by remember(botId) { mutableStateOf(bot?.name.orEmpty()) }
    var subtitleText by remember(botId) { mutableStateOf(bot?.purpose.orEmpty()) }
    var showMenu by remember { mutableStateOf(false) }
    var showPhotoMenu by remember { mutableStateOf(false) }
    var showAdvanced by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    // Name, subtitle and character edits apply at once and save in the background (R15).
    val saveHost = remember(client) { coordinator.botSaveHost() }
    var editor by remember(botId) { mutableStateOf<AidenBotIdentityEditor?>(null) }
    LaunchedEffect(botId, bot != null, client) {
        val current = bot ?: return@LaunchedEffect
        editor = coordinator.botIdentityEditor(current)
    }
    val editState = editor?.state?.collectAsStateWithLifecycle()?.value
    val avatarModel = remember(botId) { AidenBotGeneratedAvatarModel(coordinator, botId, coordinator.botCache) }
    val photoPhase by avatarModel.phase.collectAsStateWithLifecycle()
    val photoError by avatarModel.errorMessage.collectAsStateWithLifecycle()
    val canDelete = aidenBotDeleteAvailable(serverInfo, botDeleter)
    // Revision 37: Pause Bot / Resume Bot, one at a time, reusing a key whose outcome is unknown.
    val pauseControl = remember(botId, client) { AidenBotPauseControl() }
    var isChangingPause by remember(botId) { mutableStateOf(false) }
    val canPause = aidenBotOffersPause(
        serverInfo,
        canWriteBots = coordinator.installationStore.activeInstallation?.canWriteBots == true,
        bot = bot
    )

    /**
     * A Bot for the page and every screen. [confirmed] is the Mac's answer, kept on disk; an
     * Advanced Save on its way (or its rollback) is only shown. Pinned either way: a Bot from
     * another pairing's save never lands in this one's cache.
     */
    fun accept(detail: AidenBotDetail, confirmed: Boolean) {
        bot = detail
        nameText = detail.name
        subtitleText = detail.purpose
        if (confirmed) saveHost.cache(detail) else saveHost.show(detail)
        editor?.adopt(detail)
        onBotMutated()
    }

    // What the editor shows (an edit, a rollback, the Mac's Bot) is what the page shows. Text the
    // person hasn't touched since follows it; what they are typing stays.
    LaunchedEffect(editState?.bot) {
        val shown = editState?.bot ?: return@LaunchedEffect
        val before = bot
        if (before == null || nameText == before.name) nameText = shown.name
        if (before == null || subtitleText == before.purpose) subtitleText = shown.purpose
        bot = shown
    }
    // A save the Mac confirmed: the list behind rereads.
    var wasSaving by remember { mutableStateOf(false) }
    LaunchedEffect(editState?.isSaving) {
        val saving = editState?.isSaving == true
        if (wasSaving && !saving && editState?.failure == null) onBotMutated()
        wasSaving = saving
    }

    LaunchedEffect(client, botId, connectionState, readAttempt) {
        val cl = client ?: run {
            isLoading = false
            return@LaunchedEffect
        }
        // The pairing this read belongs to; a removed or switched pairing never gets it back.
        val requestInstance = coordinator.activeInstanceId
        isLoading = true
        loadFailed = false
        try {
            val fresh = cl.bot(botId)
            if (!coordinator.holdsReadAuthority(cl, requestInstance)) return@LaunchedEffect
            loadFailed = false
            // An edit still saving shows over the read; it settles on the Mac's own answer.
            if (editor?.isBusy == true) return@LaunchedEffect
            bot = fresh
            nameText = fresh.name
            subtitleText = fresh.purpose
            saveHost.cache(fresh)
            editor?.adopt(fresh)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            loadFailed = bot == null
        } finally {
            isLoading = false
        }
    }

    // Profile → Memory's quiet count (revision 27). A failed read keeps the row without a count.
    val supportsMemory = serverInfo?.supportsBotMemory == true
    var memorySummary by remember(botId) { mutableStateOf<AidenBotMemorySummary?>(null) }
    LifecycleResumeEffect(client, botId, supportsMemory) {
        val cl = client
        val job = if (cl != null && supportsMemory) scope.launch {
            val requestInstance = coordinator.activeInstanceId
            try {
                val view = cl.botMemory(botId)
                if (coordinator.holdsReadAuthority(cl, requestInstance)) memorySummary = AidenBotMemorySummary.of(view)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep the last count; the row still opens the page.
            }
        } else null
        onPauseOrDispose { job?.cancel() }
    }

    // Each edit shows at once and saves when the Mac is reachable; a failed one goes back (R15).
    fun saveText() {
        val current = bot ?: return
        val patch = aidenBotIdentityTextPatch(current, nameText, subtitleText)
        if (patch == null) {
            if (nameText.isBlank()) nameText = current.name
            return
        }
        val ed = editor ?: return
        actionError = null
        saveHost.launch { ed.edit(patch) }
    }

    fun saveCharacter(recipe: AidenBotAvatarRecipe) {
        val current = bot ?: return
        val patch = aidenBotCharacterPatch(current, recipe) ?: return
        val ed = editor ?: return
        actionError = null
        saveHost.launch { ed.edit(patch) }
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val current = bot ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                avatarModel.setCandidate(aidenReadPickedPhoto(context, uri))
            } catch (e: CancellationException) {
                throw e
            } catch (e: AidenBotGeneratedAvatarError) {
                actionError = e.messageText
                return@launch
            } catch (_: Exception) {
                actionError = AidenBotGeneratedAvatarError.InvalidImage.messageText
                return@launch
            }
            if (avatarModel.hasCandidate) {
                avatarModel.uploadAvatar(current.id, aidenBotAvatarExpectedRevision(current)) { updated ->
                    scope.launch { accept(updated, confirmed = true) }
                }
            }
        }
    }

    Scaffold(
        containerColor = palette.canvas,
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { showMenu = true }, enabled = bot != null) {
                            Icon(Icons.Default.MoreHoriz, contentDescription = stringResource(R.string.action_more_options), tint = palette.foreground)
                        }
                        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }, containerColor = palette.raised) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.bot_advanced_title)) },
                                leadingIcon = { Icon(Icons.Default.Tune, contentDescription = null) },
                                onClick = {
                                    showMenu = false
                                    showAdvanced = true
                                }
                            )
                            if (canPause) {
                                val paused = bot?.paused == true
                                DropdownMenuItem(
                                    text = { Text(stringResource(if (paused) R.string.bot_menu_resume else R.string.bot_menu_pause)) },
                                    leadingIcon = {
                                        Icon(if (paused) Icons.Outlined.PlayCircle else Icons.Outlined.PauseCircle, contentDescription = null)
                                    },
                                    enabled = !isChangingPause,
                                    onClick = {
                                        showMenu = false
                                        val cl = client
                                        val current = bot
                                        if (cl != null && current != null) {
                                            val pairing = coordinator.activeInstanceId
                                            isChangingPause = true
                                            actionError = null
                                            scope.launch {
                                                try {
                                                    val next = pauseControl.set(AidenRemoteBotPauseTransport(cl), current, pause = !paused)
                                                    if (next != null && coordinator.holdsReadAuthority(cl, pairing)) {
                                                        // Shown at once; the Mac's own Bot replaces it on the reread.
                                                        bot = next
                                                        onBotMutated()
                                                        readAttempt += 1
                                                    }
                                                } catch (e: CancellationException) {
                                                    throw e
                                                } catch (_: Exception) {
                                                    actionError = resources.getString(
                                                        if (paused) R.string.bot_profile_resume_failed else R.string.bot_profile_pause_failed,
                                                        current.name
                                                    )
                                                } finally {
                                                    isChangingPause = false
                                                }
                                            }
                                        }
                                    }
                                )
                            }
                            if (canDelete) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.bot_delete_confirm), color = aidenBotErrorTextColor()) },
                                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = palette.danger) },
                                    onClick = {
                                        showMenu = false
                                        confirmingDelete = true
                                    }
                                )
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas)
            )
        }
    ) { padding ->
        val current = bot
        val presentation = AidenReadPresentation.of(
            hasContent = current != null,
            isFetching = isLoading,
            // Connecting is not settled: skeletons, never a "connect" screen, until it fails (R14).
            hasSettled = loadFailed || connectionState == AidenConnectionState.NEEDS_PAIRING,
            failed = loadFailed
        )
        when {
            current == null && presentation == AidenReadPresentation.SKELETON -> AidenBotProfileSkeleton(Modifier.padding(padding))
            current == null -> AidenEmptyState(
                icon = Icons.Default.CloudOff,
                title = stringResource(R.string.bot_profile_unavailable_title),
                body = if (client == null) stringResource(R.string.bot_profile_unavailable_connect) else stringResource(R.string.bot_profile_unavailable_failed),
                modifier = Modifier.fillMaxSize().padding(padding),
                action = if (client != null) {
                    { AidenTonalButton(text = stringResource(R.string.action_try_again), onClick = { readAttempt += 1 }) }
                } else null
            )
            else -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .aidenReadableWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp)
            ) {
                val changePhotoLabel = stringResource(R.string.bot_profile_change_photo)
                val photoOptionsLabel = stringResource(R.string.bot_profile_photo_options)
                Box {
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .clickable(onClickLabel = changePhotoLabel) { showPhotoMenu = true }
                    ) {
                        AidenBotCanonicalAvatarView(
                            coordinator = coordinator,
                            botId = current.id,
                            avatar = current.avatar,
                            name = current.name,
                            size = 120.dp
                        )
                        // A photo on its way shimmers over the face, never a spinner (R15).
                        if (photoPhase == AidenBotGeneratedAvatarPhase.UPLOADING || photoPhase == AidenBotGeneratedAvatarPhase.REVERTING) {
                            val saving = stringResource(R.string.bot_avatar_saving)
                            AidenSkeletonBlock(
                                width = 120.dp,
                                height = 120.dp,
                                shape = CircleShape,
                                modifier = Modifier.alpha(0.7f).semantics { stateDescription = saving }
                            )
                        }
                    }
                    Surface(
                        onClick = { showPhotoMenu = true },
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(36.dp)
                            .semantics { contentDescription = photoOptionsLabel }
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.MoreHoriz, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(18.dp))
                        }
                    }
                    DropdownMenu(expanded = showPhotoMenu, onDismissRequest = { showPhotoMenu = false }, containerColor = palette.raised) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.bot_profile_choose_photo)) },
                            leadingIcon = { Icon(Icons.Default.PhotoLibrary, contentDescription = null) },
                            onClick = {
                                showPhotoMenu = false
                                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            }
                        )
                        if (current.avatar.asset != null) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.bot_profile_remove_photo)) },
                                leadingIcon = { Icon(Icons.Default.HideImage, contentDescription = null) },
                                onClick = {
                                    showPhotoMenu = false
                                    scope.launch {
                                        avatarModel.deleteAvatar(current.id, aidenBotAvatarExpectedRevision(current)) { updated ->
                                            scope.launch { accept(updated, confirmed = true) }
                                        }
                                    }
                                }
                            )
                        }
                    }
                }
                photoError?.let { Text(it, color = aidenBotErrorTextColor(), style = MaterialTheme.typography.bodySmall) }

                Surface(color = palette.raised, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
                    Column {
                        AidenBotInlineField(
                            value = nameText,
                            onValueChange = { nameText = it.take(AidenBotWire.MAX_NAME_LENGTH) },
                            placeholder = stringResource(R.string.bot_field_name),
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold, color = palette.foreground),
                            onCommit = { saveText() },
                            onDone = { focusManager.clearFocus() }
                        )
                        HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(horizontal = 16.dp))
                        AidenBotInlineField(
                            value = subtitleText,
                            onValueChange = { subtitleText = it.take(AidenBotWire.MAX_PURPOSE_LENGTH) },
                            placeholder = stringResource(R.string.bot_profile_subtitle_placeholder),
                            style = MaterialTheme.typography.bodyLarge.copy(color = palette.secondary),
                            onCommit = { saveText() },
                            onDone = { focusManager.clearFocus() }
                        )
                    }
                }

                // Never held back while a save runs: each pick shows at once and saves after the last.
                AidenBotCharacterCard(
                    recipe = AidenBotCharacter.recipe(current.avatar.semantic),
                    onChange = ::saveCharacter
                )

                Surface(
                    onClick = { onNavigateToEditBot(current.id) },
                    color = palette.raised,
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp)
                    ) {
                        Icon(Icons.Default.Description, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.bot_profile_instructions), style = MaterialTheme.typography.bodyLarge, color = palette.foreground, modifier = Modifier.weight(1f))
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = palette.secondary)
                    }
                }

                if (supportsMemory) {
                    Surface(
                        onClick = { onNavigateToMemory(current.id) },
                        color = palette.raised,
                        shape = MaterialTheme.shapes.large,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp)
                        ) {
                            Icon(Icons.Outlined.SdStorage, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(12.dp))
                            Text(stringResource(R.string.bot_memory_title), style = MaterialTheme.typography.bodyLarge, color = palette.foreground, modifier = Modifier.weight(1f))
                            memorySummary?.let { summary ->
                                Text(
                                    when (summary) {
                                        AidenBotMemorySummary.Unreadable -> stringResource(R.string.bot_memory_count_unreadable)
                                        AidenBotMemorySummary.Empty -> stringResource(R.string.bot_memory_count_empty)
                                        is AidenBotMemorySummary.Things ->
                                            pluralStringResource(R.plurals.bot_memory_count, summary.count, summary.count)
                                    },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.secondary
                                )
                                Spacer(Modifier.width(4.dp))
                            }
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = palette.secondary)
                        }
                    }
                }

                if (serverInfo?.supportsBotRoutines == true) {
                    AidenBotRoutinesSection(
                        botId = current.id,
                        client = client,
                        offersSuggestions = serverInfo?.supportsBotProactive == true
                    )
                }

                (editState?.failure?.let { stringResource(aidenBotSaveFailureText(it)) } ?: actionError)?.let {
                    Text(it, color = aidenBotErrorTextColor(), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    val current = bot
    if (showAdvanced && current != null) {
        AidenBotAdvancedSheet(
            bot = current,
            client = client,
            onDismiss = { showAdvanced = false },
            // Save applies at once (R15): the optimistic Bot now, the Mac's when it answers.
            onSaved = {
                accept(it, confirmed = false)
                showAdvanced = false
            },
            saveHost = saveHost,
            // The Mac's Bot is already kept by the save; a rollback is only shown.
            onSaveSettled = { accept(it, confirmed = false) },
            onSaveFailed = coordinator::presentError,
            chatActivityAvailable = aidenBotShowsChatActivity(serverInfo, hasBaseline = true, cachedSupport = coordinator.cachedBotActivitySupported),
            chatActivityHost = remember(client) { coordinator.botChatActivityHost() },
            // The baseline only: unsaved name or subtitle edits stay, and the host has cached the pick.
            onChatActivitySaved = { bot = it }
        )
    }

    if (confirmingDelete && current != null) {
        AidenBotDeleteDialog(
            name = current.name,
            isDeleting = isDeleting,
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                val cl = client
                val deleter = botDeleter
                if (cl == null || deleter == null) {
                    confirmingDelete = false
                    actionError = resources.getString(R.string.bot_delete_connect)
                    return@AidenBotDeleteDialog
                }
                scope.launch {
                    isDeleting = true
                    try {
                        deleter.delete(cl, current.id)
                        confirmingDelete = false
                        onBotMutated()
                        onBotDeleted()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        confirmingDelete = false
                        actionError = resources.getString(R.string.bot_delete_failed)
                    } finally {
                        isDeleting = false
                    }
                }
            }
        )
    }
}

/** Profile-shaped placeholders for a Bot opened with nothing saved on this phone. */
@Composable
private fun AidenBotProfileSkeleton(modifier: Modifier = Modifier) {
    val loadingDescription = stringResource(R.string.bot_profile_loading)
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(24.dp),
        modifier = modifier
            .fillMaxSize()
            .aidenReadableWidth()
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = loadingDescription }
    ) {
        AidenSkeletonBlock(width = 120.dp, height = 120.dp, shape = CircleShape)
        AidenSkeletonBlock(height = 112.dp, shape = MaterialTheme.shapes.large)
        AidenSkeletonBlock(height = 160.dp, shape = MaterialTheme.shapes.large)
        AidenSkeletonBlock(height = 56.dp, shape = MaterialTheme.shapes.large)
    }
}

/** A borderless centred field that saves when it loses focus or the keyboard's Done is pressed. */
@Composable
private fun AidenBotInlineField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    style: TextStyle,
    onCommit: () -> Unit,
    onDone: () -> Unit
) {
    val palette = AidenTheme.palette
    var focused by remember { mutableStateOf(false) }
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center
    ) {
        if (value.isEmpty()) {
            Text(placeholder, style = style.copy(color = palette.secondary), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = style.copy(textAlign = TextAlign.Center),
            cursorBrush = SolidColor(palette.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = placeholder }
                .onFocusChanged { state ->
                    if (focused && !state.isFocused) onCommit()
                    focused = state.isFocused
                }
        )
    }
}
