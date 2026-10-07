package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.*
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupOrientation
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import androidx.annotation.StringRes

/**
 * 1:1 Parity iOS Glass Composer for Aiden On-The-Go.
 * Encapsulates multi-line auto-expanding text field, spring-revealed attachment strip and
 * banners, the model/thinking pill and sheet, the harmonic voice waveform, and the
 * circle-to-squircle morphing send/stop action.
 */
@Composable
fun AidenComposerView(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    canStop: Boolean = true,
    canSend: Boolean,
    isStreaming: Boolean,
    showsRunInputOptions: Boolean = false,
    canSubmitRunInput: Boolean = false,
    onSubmitRunInput: (AidenStreamInputMode) -> Unit = {},
    runInputMode: AidenStreamInputMode = AidenRunInputPresentation.defaultMode,
    onRunInputModeChange: (AidenStreamInputMode) -> Unit = {},
    runInputReceipt: String? = null,
    isVoiceListening: Boolean,
    isVoiceBusy: Boolean = false,
    onToggleVoice: () -> Unit,
    pendingAttachments: List<AidenComposerPendingAttachment> = emptyList(),
    onRemoveAttachment: (AidenComposerPendingAttachment) -> Unit = {},
    onAddImage: () -> Unit = {},
    onAddFile: () -> Unit = {},
    selectedSkill: AidenRemoteSkillCatalogEntry? = null,
    onClearSkill: () -> Unit = {},
    composerSuggestions: List<AidenComposerSuggestion> = emptyList(),
    onSelectSuggestion: (AidenComposerSuggestion) -> Unit = {},
    selectedProvider: AidenProvider? = null,
    selectedModel: AidenModel? = null,
    selectedThinkingLevel: String? = null,
    availableProviders: List<AidenProvider> = emptyList(),
    onSelectModel: ((AidenProvider, AidenModel, String?) -> Unit)? = null,
    defaultModelRoute: AidenModelRoute? = null,
    recentModelRoutes: List<AidenModelRoute> = emptyList(),
    placeholder: String = stringResource(R.string.chat_composer_placeholder),
    isReadOnly: Boolean = false,
    voiceErrorMessage: String? = null,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    var isFieldFocused by remember { mutableStateOf(false) }
    var showModelMenu by remember { mutableStateOf(false) }
    var showAttachmentMenu by remember { mutableStateOf(false) }
    val surfaceColor by animateColorAsState(
        targetValue = if (isFieldFocused) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "composer_surface"
    )

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
            .shadow(
                elevation = if (isFieldFocused) 6.dp else 4.dp,
                shape = RoundedCornerShape(AidenUi.ComposerRadius),
                ambientColor = Color.Black.copy(alpha = 0.08f),
                spotColor = Color.Black.copy(alpha = 0.08f)
        ),
        shape = RoundedCornerShape(AidenUi.ComposerRadius),
        color = surfaceColor
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp)
        ) {
            // 1. Pending Attachments Carousel
            AidenComposerReveal(value = pendingAttachments.takeIf { it.isNotEmpty() }) { attachments ->
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                ) {
                    items(attachments, key = { it.id }) { attachment ->
                        Surface(
                            color = palette.canvas.copy(alpha = 0.7f),
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier.animateItem(
                                fadeInSpec = if (reduceMotion) null else AidenMotion.nonSpatialExpressiveSpring(),
                                placementSpec = if (reduceMotion) null else AidenMotion.spatialExpressiveSpring(),
                                fadeOutSpec = if (reduceMotion) null else AidenMotion.nonSpatialExpressiveSpring()
                            )
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp)
                            ) {
                                Icon(
                                    imageVector = if (attachment.isImage) Icons.Default.Image else Icons.Default.Description,
                                    contentDescription = null,
                                    tint = palette.accent,
                                    modifier = Modifier.size(14.dp)
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                Text(
                                    text = attachment.name,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.foreground,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.widthIn(max = 140.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                IconButton(
                                    onClick = { onRemoveAttachment(attachment) },
                                    modifier = Modifier.size(48.dp)
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Close,
                                        contentDescription = stringResource(R.string.chat_composer_remove_attachment, attachment.name),
                                        tint = palette.secondary,
                                        modifier = Modifier.size(16.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // 2. Selected-skill chip: the palette selection rides the send as
            // an opaque lease the Mac redeems; removing it keeps the draft.
            AidenComposerReveal(value = selectedSkill) { skill ->
                val removeSkillLabel = stringResource(R.string.chat_composer_remove_skill, skill.name)
                Surface(
                    color = palette.secondary.copy(alpha = 0.12f),
                    shape = CircleShape,
                    modifier = Modifier.padding(bottom = 6.dp)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(start = 10.dp, top = 6.dp, bottom = 6.dp, end = 4.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.AutoAwesome,
                            contentDescription = null,
                            tint = palette.secondary,
                            modifier = Modifier.size(13.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "/${skill.name}",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Medium,
                            color = palette.secondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        IconButton(
                            onClick = onClearSkill,
                            modifier = Modifier
                                .size(AidenUi.MinimumTouchTarget)
                                .semantics { contentDescription = removeSkillLabel }
                        ) {
                            Icon(
                                imageVector = Icons.Default.Close,
                                contentDescription = null,
                                tint = palette.secondary,
                                modifier = Modifier.size(14.dp)
                            )
                        }
                    }
                }
            }

            // 3. `/` and `@` suggestion palette — bounded rows above the field.
            AidenComposerReveal(value = composerSuggestions.takeIf { it.isNotEmpty() }) { suggestions ->
                AidenComposerSuggestionList(
                    suggestions = suggestions,
                    palette = palette,
                    onSelect = onSelectSuggestion,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 6.dp)
                )
            }

            // 4. Multiline Auto-Expanding Text Field
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                contentAlignment = Alignment.CenterStart
            ) {
                if (draft.isEmpty() && !isVoiceListening) {
                    Text(
                        text = placeholder,
                        style = MaterialTheme.typography.bodyLarge,
                        color = palette.secondary
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    readOnly = isReadOnly || isVoiceBusy,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(
                        color = palette.foreground,
                        fontSize = 16.sp,
                        lineHeight = 24.sp
                    ),
                    cursorBrush = SolidColor(palette.accent),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = if (canSend && !isStreaming) ImeAction.Send else ImeAction.Default
                    ),
                    keyboardActions = KeyboardActions(
                        onSend = { if (canSend && !isStreaming) onSend() }
                    ),
                    maxLines = 6,
                    modifier = Modifier
                        .fillMaxWidth()
                        .onFocusChanged { isFieldFocused = it.isFocused }
                )
            }

            // 3. Bottom Controls Row
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
            ) {
                // iOS parity: expose images and files as distinct native choices.
                Box {
                    val attachInteraction = remember { MutableInteractionSource() }
                    IconButton(
                        onClick = { showAttachmentMenu = true },
                        enabled = !isReadOnly && !isStreaming && pendingAttachments.size < 10,
                        interactionSource = attachInteraction,
                        modifier = Modifier
                            .size(AidenUi.MinimumTouchTarget)
                            .tactilePress(attachInteraction)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surfaceContainer)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = stringResource(R.string.chat_composer_add_attachment),
                            tint = if (!isReadOnly && !isStreaming) palette.foreground else palette.secondary.copy(alpha = 0.4f),
                            modifier = Modifier.size(20.dp)
                        )
                    }

                    DropdownMenu(
                        expanded = showAttachmentMenu,
                        onDismissRequest = { showAttachmentMenu = false },
                        shape = MaterialTheme.shapes.large,
                        containerColor = MaterialTheme.colorScheme.surfaceContainer
                    ) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_composer_photo_library)) },
                            leadingIcon = {
                                Icon(
                                    Icons.Default.PhotoLibrary,
                                    contentDescription = null,
                                    tint = palette.foreground
                                )
                            },
                            onClick = {
                                showAttachmentMenu = false
                                onAddImage()
                            }
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_composer_choose_file)) },
                            leadingIcon = {
                                Icon(
                                    Icons.Default.Description,
                                    contentDescription = null,
                                    tint = palette.foreground
                                )
                            },
                            onClick = {
                                showAttachmentMenu = false
                                onAddFile()
                            }
                        )
                    }
                }

                Spacer(modifier = Modifier.width(8.dp))

                // Model & Thinking Level Selector Pill (for Workspace Chats).
                // It takes the flexible space and shortens first, so the mic,
                // the busy Queue/Steer pill and Stop always keep their width.
                if (availableProviders.isNotEmpty() && onSelectModel != null) {
                    Box(
                        contentAlignment = Alignment.CenterStart,
                        modifier = Modifier
                            .weight(1f)
                            .padding(end = 8.dp)
                    ) {
                        val pickerInteraction = remember { MutableInteractionSource() }
                        Surface(
                            onClick = { showModelMenu = true },
                            color = MaterialTheme.colorScheme.surfaceContainer,
                            shape = MaterialTheme.shapes.extraLarge,
                            interactionSource = pickerInteraction,
                            modifier = Modifier
                                .heightIn(min = AidenUi.MinimumTouchTarget)
                                .tactilePress(pickerInteraction)
                                .semantics { role = Role.Button }
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                            ) {
                                if (selectedProvider != null) {
                                    AidenProviderIcon(
                                        providerId = selectedProvider.id,
                                        providerLabel = selectedProvider.label,
                                        modelId = selectedModel?.id,
                                        artwork = selectedProvider.artwork,
                                        size = 18.dp,
                                        modifier = Modifier.clearAndSetSemantics {}
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                }
                                // One label so a narrow picker shortens the name and
                                // thinking level together, keeping the provider icon
                                // and chevron visible.
                                Text(
                                    text = buildAnnotatedString {
                                        append(selectedModel?.label ?: stringResource(R.string.model_picker_default))
                                        if (selectedThinkingLevel != null) {
                                            withStyle(SpanStyle(fontWeight = FontWeight.Normal, color = palette.secondary.copy(alpha = 0.8f))) {
                                                append(" · ${selectedThinkingLevel.replaceFirstChar { it.uppercase() }}")
                                            }
                                        }
                                    },
                                    style = MaterialTheme.typography.labelMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = palette.secondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Icon(
                                    imageVector = Icons.Default.KeyboardArrowDown,
                                    contentDescription = stringResource(R.string.model_picker_select),
                                    tint = palette.secondary,
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                        }

                        if (showModelMenu) {
                            AidenComposerModelSheet(
                                availableProviders = availableProviders,
                                selectedProvider = selectedProvider,
                                selectedModel = selectedModel,
                                selectedThinkingLevel = selectedThinkingLevel,
                                onSelectModel = onSelectModel,
                                onDismiss = { showModelMenu = false },
                                defaultRoute = defaultModelRoute,
                                recentRoutes = recentModelRoutes
                            )
                        }
                    }
                } else {
                    Spacer(modifier = Modifier.weight(1f))
                }

                // Voice Mic / Waveform Button. Dictation is off while a response
                // streams, so the busy Queue/Steer pill takes its place (a
                // dictation already running keeps its stop control).
                val showsBusyPill = isStreaming && showsRunInputOptions
                if (!showsBusyPill || isVoiceListening) {
                    AidenComposerMorphingAction(
                        state = aidenComposerVoiceActionState(isVoiceListening),
                        containerColor = if (isVoiceListening) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                        onClick = onToggleVoice,
                        enabled = !isReadOnly && !isStreaming && (!isVoiceBusy || isVoiceListening)
                    ) {
                        if (isVoiceListening) {
                            // The live waveform loops forever, so reduced motion shows a still glyph.
                            if (reduceMotion) {
                                Icon(
                                    imageVector = Icons.Default.GraphicEq,
                                    contentDescription = stringResource(R.string.chat_composer_stop_voice),
                                    tint = palette.accent,
                                    modifier = Modifier.size(20.dp)
                                )
                            } else {
                                val stopVoiceLabel = stringResource(R.string.chat_composer_stop_voice)
                                AidenHarmonicWaveform(
                                    amplitude = 0.8f,
                                    palette = palette,
                                    modifier = Modifier
                                        .size(24.dp, 16.dp)
                                        .semantics { contentDescription = stopVoiceLabel }
                                )
                            }
                        } else {
                            Icon(
                                imageVector = Icons.Default.Mic,
                                contentDescription = stringResource(R.string.chat_composer_start_voice),
                                tint = palette.secondary,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.width(8.dp))
                }

                // Busy composer: negotiated servers get one Queue/Steer split
                // button next to its own Stop control; older servers keep the
                // single morphing button.
                if (showsBusyPill) {
                    val canSubmitNow = canSubmitRunInput && !isReadOnly && draft.isNotBlank()
                    AidenRunInputSplitButton(
                        mode = runInputMode,
                        canSubmit = canSubmitNow,
                        canChooseMode = !isReadOnly,
                        onSubmit = { onSubmitRunInput(runInputMode) },
                        onPickMode = { mode ->
                            // Picking a mode sends the draft in that mode; with
                            // nothing to send it only switches.
                            onRunInputModeChange(mode)
                            if (canSubmitNow) onSubmitRunInput(mode)
                        }
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    AidenComposerMorphingAction(
                        state = AidenComposerActionState.BUSY,
                        containerColor = palette.danger,
                        onClick = onStop,
                        enabled = canStop && !isReadOnly
                    ) {
                        Icon(
                            imageVector = Icons.Default.Stop,
                            contentDescription = stringResource(R.string.chat_composer_stop_generation),
                            tint = Color.White,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                } else {
                    // Morphing Send / Stop action: a circle while it waits to
                    // send, a squircle while it stops the running response.
                    AidenComposerMorphingAction(
                        state = aidenComposerSendActionState(isStreaming, canSend),
                        containerColor = when {
                            isStreaming -> palette.danger
                            canSend -> palette.accent
                            else -> palette.canvas.copy(alpha = 0.6f)
                        },
                        onClick = {
                            if (isStreaming) {
                                onStop()
                            } else if (canSend) {
                                onSend()
                            }
                        },
                        enabled = (if (isStreaming) canStop else canSend) && !isReadOnly
                    ) {
                        AnimatedContent(
                            targetState = isStreaming,
                            transitionSpec = {
                                if (reduceMotion) {
                                    EnterTransition.None togetherWith ExitTransition.None
                                } else {
                                    (scaleIn(AidenMotion.spatialExpressiveSpring()) + fadeIn(AidenMotion.nonSpatialExpressiveSpring()))
                                        .togetherWith(scaleOut(AidenMotion.spatialExpressiveSpring()) + fadeOut(AidenMotion.nonSpatialExpressiveSpring()))
                                }
                            },
                            label = "send_stop_morph"
                        ) { streaming ->
                            if (streaming) {
                                Icon(
                                    imageVector = Icons.Default.Stop,
                                    contentDescription = stringResource(R.string.chat_composer_stop_generation),
                                    tint = Color.White,
                                    modifier = Modifier.size(18.dp)
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Default.ArrowUpward,
                                    contentDescription = stringResource(R.string.chat_composer_send),
                                    tint = if (canSend) palette.onAccent else palette.secondary.copy(alpha = 0.4f),
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    }
                }
            }

            // Brief inline receipt for admitted/committed run inputs
            AidenComposerReveal(value = runInputReceipt) { receipt ->
                Text(
                    text = receipt,
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.secondary,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp)
                )
            }

            // Voice Error Hint if applicable
            AidenComposerReveal(value = voiceErrorMessage?.takeIf { !isVoiceListening }) { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.danger,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp)
                )
            }
        }
    }
}

private data class AidenRunInputModeOption(
    val mode: AidenStreamInputMode,
    @StringRes val label: Int,
    @StringRes val detail: Int,
    @StringRes val actionLabel: Int
)

// Menu order matches desktop and iOS: Steer first, then Queue.
private val runInputModeOptions = listOf(
    AidenRunInputModeOption(AidenStreamInputMode.STEER, R.string.chat_composer_mode_steer, R.string.chat_composer_mode_steer_detail, R.string.chat_composer_mode_steer_action),
    AidenRunInputModeOption(AidenStreamInputMode.QUEUE, R.string.chat_composer_mode_queue, R.string.chat_composer_mode_queue_detail, R.string.chat_composer_mode_queue_action)
)

/**
 * Send control while a response runs (desktop/iOS parity), shaped as an M3 Expressive
 * split button: the leading segment sends the draft in the current mode and the trailing
 * chevron segment opens the Steer / Queue menu. Long-pressing the leading segment opens
 * the same menu. Only the leading segment dims when there is nothing to send, so a mode
 * can still be picked before typing. While the menu is open the chevron segment rounds
 * into a full circle and its chevron turns.
 *
 * This keeps the foundation `AidenSplitButton` geometry but adds what the busy composer
 * needs and that primitive does not expose: a long-press menu, independent enablement
 * of the two segments, an announced action label, and a springing mode label.
 */
@Composable
private fun AidenRunInputSplitButton(
    mode: AidenStreamInputMode,
    canSubmit: Boolean,
    canChooseMode: Boolean,
    onSubmit: () -> Unit,
    onPickMode: (AidenStreamInputMode) -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val current = runInputModeOptions.first { it.mode == mode }
    val currentActionLabel = stringResource(current.actionLabel)
    val chooseActionLabel = stringResource(R.string.chat_composer_choose_action)
    var showMenu by remember { mutableStateOf(false) }
    val height = AidenUi.MinimumTouchTarget
    val primaryAlpha by animateFloatAsState(
        targetValue = if (canSubmit) 1f else 0.6f,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "run_input_primary_alpha"
    )
    val chevronRotation by animateFloatAsState(
        targetValue = if (showMenu) 180f else 0f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "run_input_chevron"
    )
    val trailingInner by animateDpAsState(
        targetValue = if (showMenu) height / 2 else AidenShape.SplitInner,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "run_input_trailing_inner"
    )
    val trailingOuter by animateDpAsState(
        targetValue = if (showMenu) height / 2 else AidenShape.SplitOuter,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "run_input_trailing_outer"
    )
    val primaryShape = aidenGroupItemShape(0, 2, AidenShape.SplitOuter, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL)
    val trailingShape = RoundedCornerShape(
        topStart = trailingInner,
        bottomStart = trailingInner,
        topEnd = trailingOuter,
        bottomEnd = trailingOuter
    )
    val primaryInteraction = remember { MutableInteractionSource() }
    val menuInteraction = remember { MutableInteractionSource() }

    Row(
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap),
        modifier = Modifier.height(height)
    ) {
        Surface(
            shape = primaryShape,
            color = palette.accent,
            modifier = Modifier
                .fillMaxHeight()
                .widthIn(min = AidenUi.MinimumTouchTarget)
                .graphicsLayer { alpha = primaryAlpha }
                .tactilePress(primaryInteraction)
                .clip(primaryShape)
                .combinedClickable(
                    interactionSource = primaryInteraction,
                    indication = ripple(),
                    enabled = canChooseMode,
                    role = Role.Button,
                    onLongClickLabel = chooseActionLabel,
                    onLongClick = { showMenu = true },
                    onClick = { if (canSubmit) onSubmit() }
                )
                .semantics {
                    contentDescription = currentActionLabel
                    if (!canSubmit) disabled()
                }
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.padding(start = 16.dp, end = 12.dp)
            ) {
                AnimatedContent(
                    targetState = current.label,
                    transitionSpec = {
                        if (reduceMotion) {
                            EnterTransition.None togetherWith ExitTransition.None
                        } else {
                            (slideInVertically(AidenMotion.spatialExpressiveSpring()) { it / 2 } +
                                fadeIn(AidenMotion.nonSpatialExpressiveSpring()))
                                .togetherWith(
                                    slideOutVertically(AidenMotion.spatialExpressiveSpring()) { -it / 2 } +
                                        fadeOut(AidenMotion.nonSpatialExpressiveSpring())
                                )
                                .using(SizeTransform(clip = true))
                        }
                    },
                    label = "run_input_mode_label"
                ) { label ->
                    Text(
                        text = stringResource(label),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.onAccent,
                        maxLines = 1,
                        // The segment announces its action instead.
                        modifier = Modifier.clearAndSetSemantics {}
                    )
                }
            }
        }
        Box {
            Surface(
                onClick = { showMenu = !showMenu },
                enabled = canChooseMode,
                shape = trailingShape,
                color = palette.accent,
                interactionSource = menuInteraction,
                modifier = Modifier
                    .fillMaxHeight()
                    .width(height)
                    .tactilePress(menuInteraction)
                    .semantics {
                        role = Role.Button
                        contentDescription = chooseActionLabel
                    }
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = null,
                        tint = palette.onAccent,
                        modifier = Modifier
                            .size(18.dp)
                            .graphicsLayer { rotationZ = chevronRotation }
                    )
                }
            }
            DropdownMenu(
                expanded = showMenu,
                onDismissRequest = { showMenu = false },
                shape = MaterialTheme.shapes.large,
                containerColor = MaterialTheme.colorScheme.surfaceContainer
            ) {
                runInputModeOptions.forEach { option ->
                    val isCurrent = option.mode == mode
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(
                                    text = stringResource(option.label),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                                    color = palette.foreground
                                )
                                Text(
                                    text = stringResource(option.detail),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary
                                )
                            }
                        },
                        trailingIcon = {
                            if (isCurrent) {
                                Icon(Icons.Default.Check, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                            } else {
                                Spacer(modifier = Modifier.size(18.dp))
                            }
                        },
                        onClick = {
                            showMenu = false
                            onPickMode(option.mode)
                        },
                        modifier = Modifier.semantics { selected = isCurrent }
                    )
                }
            }
        }
    }
}

/** `/` skill and `@` mention suggestion rows, bounded to the shared visible
 * maximum. Selecting a row is a pure composer action — skill rows set the
 * pending lease, mention rows insert plain text. */
@Composable
private fun AidenComposerSuggestionList(
    suggestions: List<AidenComposerSuggestion>,
    palette: AidenPalette,
    onSelect: (AidenComposerSuggestion) -> Unit,
    modifier: Modifier = Modifier
) {
    val visible = suggestions.take(6)
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            visible.forEachIndexed { index, suggestion ->
                val enabled = when (suggestion) {
                    is AidenComposerSuggestion.Skill -> suggestion.entry.available
                    else -> true
                }
                val label = when (suggestion) {
                    is AidenComposerSuggestion.Skill ->
                        if (suggestion.entry.available) stringResource(R.string.chat_composer_suggest_skill, suggestion.entry.name)
                        else stringResource(R.string.chat_composer_suggest_skill_unavailable, suggestion.entry.name)
                    is AidenComposerSuggestion.Agent -> stringResource(R.string.chat_composer_suggest_agent, suggestion.agent.label)
                    is AidenComposerSuggestion.File -> stringResource(R.string.chat_composer_suggest_file, suggestion.entry.displayPath)
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics(mergeDescendants = true) { contentDescription = label }
                        .clickable(enabled = enabled) { onSelect(suggestion) }
                        .padding(horizontal = 10.dp, vertical = 8.dp)
                ) {
                    when (suggestion) {
                        is AidenComposerSuggestion.Skill -> {
                            Icon(
                                imageVector = Icons.Default.AutoAwesome,
                                contentDescription = null,
                                tint = palette.secondary,
                                modifier = Modifier.size(15.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "/${suggestion.entry.name}",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = if (suggestion.entry.available) palette.foreground else palette.secondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Text(
                                    text = if (suggestion.entry.available) suggestion.entry.description else suggestion.entry.unavailableReason.orEmpty(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.secondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = suggestion.entry.source.rawValue,
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.secondary.copy(alpha = 0.85f),
                                maxLines = 1
                            )
                        }
                        is AidenComposerSuggestion.Agent -> {
                            Icon(
                                imageVector = Icons.Default.Person,
                                contentDescription = null,
                                tint = palette.secondary,
                                modifier = Modifier.size(15.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = suggestion.agent.label,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = palette.foreground,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = stringResource(R.string.chat_composer_suggest_agent_tag),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.secondary.copy(alpha = 0.85f),
                                maxLines = 1
                            )
                        }
                        is AidenComposerSuggestion.File -> {
                            Icon(
                                imageVector = Icons.Default.Description,
                                contentDescription = null,
                                tint = palette.secondary,
                                modifier = Modifier.size(15.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = suggestion.entry.displayPath,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = palette.foreground,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = stringResource(R.string.chat_composer_suggest_file_tag),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.secondary.copy(alpha = 0.85f),
                                maxLines = 1
                            )
                        }
                    }
                }
                if (index != visible.lastIndex) {
                    HorizontalDivider(color = palette.secondary.copy(alpha = 0.15f))
                }
            }
        }
    }
}
