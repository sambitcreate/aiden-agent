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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.HideImage
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

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
    onBotMutated: () -> Unit = {},
    botDeleter: AidenBotDeleter? = null,
    onBotDeleted: () -> Unit = onNavigateBack
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val client by coordinator.client.collectAsStateWithLifecycle()
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()

    var bot by remember(botId) { mutableStateOf(coordinator.botCache.getBotDetail(botId)) }
    var isLoading by remember(botId) { mutableStateOf(bot == null) }
    var loadFailed by remember(botId) { mutableStateOf(false) }
    var nameText by remember(botId) { mutableStateOf(bot?.name.orEmpty()) }
    var subtitleText by remember(botId) { mutableStateOf(bot?.purpose.orEmpty()) }
    var showMenu by remember { mutableStateOf(false) }
    var showPhotoMenu by remember { mutableStateOf(false) }
    var showAdvanced by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var isDeleting by remember { mutableStateOf(false) }
    var isSavingCharacter by remember { mutableStateOf(false) }
    var actionError by remember { mutableStateOf<String?>(null) }
    val avatarModel = remember(botId) { AidenBotGeneratedAvatarModel(coordinator, botId, coordinator.botCache) }
    val photoPhase by avatarModel.phase.collectAsStateWithLifecycle()
    val photoError by avatarModel.errorMessage.collectAsStateWithLifecycle()
    val canDelete = aidenBotDeleteAvailable(serverInfo, botDeleter)

    fun accept(detail: AidenBotDetail) {
        bot = detail
        nameText = detail.name
        subtitleText = detail.purpose
        coordinator.botCache.putBotDetail(detail)
        onBotMutated()
    }

    LaunchedEffect(client, botId, connectionState) {
        val cl = client ?: run {
            isLoading = false
            return@LaunchedEffect
        }
        try {
            val fresh = cl.bot(botId)
            bot = fresh
            nameText = fresh.name
            subtitleText = fresh.purpose
            coordinator.botCache.putBotDetail(fresh)
            loadFailed = false
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            loadFailed = bot == null
        } finally {
            isLoading = false
        }
    }

    fun saveText() {
        val current = bot ?: return
        val patch = aidenBotIdentityTextPatch(current, nameText, subtitleText)
        if (patch == null) {
            if (nameText.isBlank()) nameText = current.name
            return
        }
        val cl = client ?: run {
            actionError = "Connect to your Mac to save changes."
            return
        }
        scope.launch {
            try {
                accept(cl.updateBotIdentity(current.id, current.revision, patch))
                actionError = null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                actionError = "Aiden couldn’t save. Try again."
            }
        }
    }

    fun saveCharacter(recipe: AidenBotAvatarRecipe) {
        val current = bot ?: return
        val patch = aidenBotCharacterPatch(current, recipe) ?: return
        val cl = client ?: run {
            actionError = "Connect to your Mac to save changes."
            return
        }
        // Show the new look right away; roll back if the Mac says no.
        bot = current.copy(avatar = current.avatar.copy(semantic = AidenBotSemanticAvatar.Recipe(recipe)))
        scope.launch {
            isSavingCharacter = true
            try {
                accept(cl.updateBotIdentity(current.id, current.revision, patch))
                actionError = null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                bot = current
                actionError = "Aiden couldn’t save the new look. Try again."
            } finally {
                isSavingCharacter = false
            }
        }
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
                    scope.launch { accept(updated) }
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { showMenu = true }, enabled = bot != null) {
                            Icon(Icons.Default.MoreHoriz, contentDescription = "More options", tint = palette.foreground)
                        }
                        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }, containerColor = palette.raised) {
                            DropdownMenuItem(
                                text = { Text("Advanced") },
                                leadingIcon = { Icon(Icons.Default.Tune, contentDescription = null) },
                                onClick = {
                                    showMenu = false
                                    showAdvanced = true
                                }
                            )
                            if (canDelete) {
                                DropdownMenuItem(
                                    text = { Text("Delete Bot", color = palette.danger) },
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
        when {
            current == null && isLoading -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = palette.accent)
            }
            current == null -> Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    if (loadFailed) "Aiden couldn’t load this Bot." else "Connect to your Mac to see this Bot.",
                    color = palette.secondary
                )
            }
            else -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp)
            ) {
                Box {
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .clickable(onClickLabel = "Change photo") { showPhotoMenu = true }
                    ) {
                        AidenBotCanonicalAvatarView(
                            coordinator = coordinator,
                            botId = current.id,
                            avatar = current.avatar,
                            name = current.name,
                            size = 120.dp
                        )
                    }
                    Surface(
                        onClick = { showPhotoMenu = true },
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(36.dp)
                            .semantics { contentDescription = "Photo options" }
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.MoreHoriz, contentDescription = null, tint = palette.foreground, modifier = Modifier.size(18.dp))
                        }
                    }
                    DropdownMenu(expanded = showPhotoMenu, onDismissRequest = { showPhotoMenu = false }, containerColor = palette.raised) {
                        DropdownMenuItem(
                            text = { Text("Choose from Gallery") },
                            leadingIcon = { Icon(Icons.Default.PhotoLibrary, contentDescription = null) },
                            onClick = {
                                showPhotoMenu = false
                                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            }
                        )
                        if (current.avatar.asset != null) {
                            DropdownMenuItem(
                                text = { Text("Remove photo") },
                                leadingIcon = { Icon(Icons.Default.HideImage, contentDescription = null) },
                                onClick = {
                                    showPhotoMenu = false
                                    scope.launch {
                                        avatarModel.deleteAvatar(current.id, aidenBotAvatarExpectedRevision(current)) { updated ->
                                            scope.launch { accept(updated) }
                                        }
                                    }
                                }
                            )
                        }
                    }
                }
                if (photoPhase == AidenBotGeneratedAvatarPhase.UPLOADING || photoPhase == AidenBotGeneratedAvatarPhase.REVERTING) {
                    LinearProgressIndicator(color = palette.accent, modifier = Modifier.width(120.dp))
                }
                photoError?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }

                Surface(color = palette.raised, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                    Column {
                        AidenBotInlineField(
                            value = nameText,
                            onValueChange = { nameText = it.take(AidenBotWire.MAX_NAME_LENGTH) },
                            placeholder = "Name",
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold, color = palette.foreground),
                            onCommit = { saveText() },
                            onDone = { focusManager.clearFocus() }
                        )
                        HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(horizontal = 16.dp))
                        AidenBotInlineField(
                            value = subtitleText,
                            onValueChange = { subtitleText = it.take(AidenBotWire.MAX_PURPOSE_LENGTH) },
                            placeholder = "What it helps with",
                            style = MaterialTheme.typography.bodyLarge.copy(color = palette.secondary),
                            onCommit = { saveText() },
                            onDone = { focusManager.clearFocus() }
                        )
                    }
                }

                AidenBotCharacterCard(
                    recipe = AidenBotCharacter.recipe(current.avatar.semantic),
                    onChange = ::saveCharacter,
                    enabled = !isSavingCharacter
                )

                Surface(
                    onClick = { onNavigateToEditBot(current.id) },
                    color = palette.raised,
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp)
                    ) {
                        Icon(Icons.Default.Description, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(12.dp))
                        Text("Instructions", style = MaterialTheme.typography.bodyLarge, color = palette.foreground, modifier = Modifier.weight(1f))
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = palette.secondary)
                    }
                }

                if (serverInfo?.supportsBotRoutines == true) {
                    AidenBotRoutinesSection(botId = current.id, client = client)
                }

                actionError?.let { Text(it, color = palette.danger, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }

    val current = bot
    if (showAdvanced && current != null) {
        AidenBotAdvancedSheet(
            bot = current,
            client = client,
            onDismiss = { showAdvanced = false },
            onSaved = {
                accept(it)
                showAdvanced = false
            }
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
                    actionError = "Connect to your Mac to delete this Bot."
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
                        actionError = "Aiden couldn’t delete this Bot. Try again."
                    } finally {
                        isDeleting = false
                    }
                }
            }
        )
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
