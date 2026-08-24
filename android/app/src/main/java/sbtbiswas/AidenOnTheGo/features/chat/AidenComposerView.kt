package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * 1:1 Parity iOS Glass Composer for Aiden On-The-Go.
 * Encapsulates multi-line auto-expanding text field, attachment preview carousel,
 * model/thinking level selector pill, harmonic voice waveform, and morphing send/stop action button.
 */
@Composable
fun AidenComposerView(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    canSend: Boolean,
    isStreaming: Boolean,
    isVoiceListening: Boolean,
    onToggleVoice: () -> Unit,
    pendingAttachments: List<AidenMessageAttachmentUpload> = emptyList(),
    onRemoveAttachment: (AidenMessageAttachmentUpload) -> Unit = {},
    onAddAttachment: () -> Unit = {},
    selectedProvider: AidenProvider? = null,
    selectedModel: AidenModel? = null,
    selectedThinkingLevel: String? = null,
    availableProviders: List<AidenProvider> = emptyList(),
    onSelectModel: ((AidenProvider, AidenModel, String?) -> Unit)? = null,
    placeholder: String = "Message Aiden",
    isReadOnly: Boolean = false,
    voiceErrorMessage: String? = null,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    var isFieldFocused by remember { mutableStateOf(false) }
    var showModelMenu by remember { mutableStateOf(false) }

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .shadow(
                elevation = if (isFieldFocused) 14.dp else 8.dp,
                shape = RoundedCornerShape(24.dp),
                ambientColor = Color.Black.copy(alpha = 0.15f),
                spotColor = palette.accent.copy(alpha = 0.2f)
            ),
        shape = RoundedCornerShape(24.dp),
        color = palette.raised.copy(alpha = 0.96f),
        border = BorderStroke(
            width = 0.75.dp,
            color = if (isFieldFocused) palette.accent.copy(alpha = 0.45f) else palette.secondary.copy(alpha = 0.18f)
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            // 1. Pending Attachments Carousel
            if (pendingAttachments.isNotEmpty()) {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                ) {
                    items(pendingAttachments, key = { it.name }) { attachment ->
                        Surface(
                            color = palette.canvas.copy(alpha = 0.7f),
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(0.5.dp, palette.secondary.copy(alpha = 0.15f)),
                            modifier = Modifier.animateItem()
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp)
                            ) {
                                Icon(
                                    imageVector = if (attachment is AidenAttachmentUpload.Image) Icons.Default.Image else Icons.Default.Description,
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
                                    modifier = Modifier.size(18.dp)
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Close,
                                        contentDescription = "Remove attachment",
                                        tint = palette.secondary,
                                        modifier = Modifier.size(12.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // 2. Multiline Auto-Expanding Text Field
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                contentAlignment = Alignment.CenterStart
            ) {
                if (draft.isEmpty() && !isVoiceListening) {
                    Text(
                        text = placeholder,
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                        color = palette.secondary.copy(alpha = 0.65f)
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    readOnly = isReadOnly,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(
                        color = palette.foreground,
                        fontSize = 15.sp,
                        lineHeight = 22.sp
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
                // Attachment Plus Button
                IconButton(
                    onClick = onAddAttachment,
                    enabled = !isReadOnly && !isStreaming,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(palette.canvas.copy(alpha = 0.5f))
                        .tactilePress { onAddAttachment() }
                ) {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = "Add attachment",
                        tint = if (!isReadOnly && !isStreaming) palette.foreground else palette.secondary.copy(alpha = 0.4f),
                        modifier = Modifier.size(18.dp)
                    )
                }

                Spacer(modifier = Modifier.width(8.dp))

                // Model & Thinking Level Selector Pill (for Workspace Chats)
                if (availableProviders.isNotEmpty() && onSelectModel != null) {
                    Box {
                        Surface(
                            color = palette.canvas.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(16.dp),
                            border = BorderStroke(0.5.dp, palette.secondary.copy(alpha = 0.15f)),
                            modifier = Modifier
                                .height(32.dp)
                                .tactilePress { showModelMenu = true }
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                            ) {
                                if (selectedProvider != null) {
                                    AidenProviderIcon(
                                        providerId = selectedProvider.id,
                                        providerLabel = selectedProvider.label,
                                        artwork = selectedProvider.artwork,
                                        size = 14.dp
                                    )
                                    Spacer(modifier = Modifier.width(5.dp))
                                }
                                Text(
                                    text = selectedModel?.label ?: "Model",
                                    style = MaterialTheme.typography.labelSmall,
                                    fontWeight = FontWeight.Medium,
                                    color = palette.secondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                if (selectedThinkingLevel != null) {
                                    Text(
                                        text = " · ${selectedThinkingLevel.replaceFirstChar { it.uppercase() }}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = palette.secondary.copy(alpha = 0.8f)
                                    )
                                }
                                Spacer(modifier = Modifier.width(3.dp))
                                Icon(
                                    imageVector = Icons.Default.KeyboardArrowDown,
                                    contentDescription = "Select model",
                                    tint = palette.secondary,
                                    modifier = Modifier.size(14.dp)
                                )
                            }
                        }

                        DropdownMenu(
                            expanded = showModelMenu,
                            onDismissRequest = { showModelMenu = false }
                        ) {
                            availableProviders.forEach { provider ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = provider.label.uppercase(),
                                            style = MaterialTheme.typography.labelSmall,
                                            fontWeight = FontWeight.Bold,
                                            color = palette.accent
                                        )
                                    },
                                    onClick = {},
                                    enabled = false
                                )
                                provider.models.forEach { model ->
                                    val isCurrentModel = selectedModel?.id == model.id && selectedProvider?.id == provider.id
                                    DropdownMenuItem(
                                        text = {
                                            Row(
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                                modifier = Modifier.fillMaxWidth()
                                            ) {
                                                Text(
                                                    text = model.label,
                                                    style = MaterialTheme.typography.bodySmall,
                                                    fontWeight = if (isCurrentModel) FontWeight.Bold else FontWeight.Normal,
                                                    color = if (isCurrentModel) palette.accent else palette.foreground
                                                )
                                                if (isCurrentModel) {
                                                    Icon(Icons.Default.Check, contentDescription = null, tint = palette.accent, modifier = Modifier.size(16.dp))
                                                }
                                            }
                                        },
                                        onClick = {
                                            onSelectModel(provider, model, null)
                                            showModelMenu = false
                                        }
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.weight(1f))

                // Voice Mic / Waveform Button
                IconButton(
                    onClick = onToggleVoice,
                    enabled = !isReadOnly && !isStreaming,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(
                            if (isVoiceListening) palette.accent.copy(alpha = 0.15f) else palette.canvas.copy(alpha = 0.5f)
                        )
                        .tactilePress { onToggleVoice() }
                ) {
                    if (isVoiceListening) {
                        AidenHarmonicWaveform(
                            amplitude = 0.8f,
                            palette = palette,
                            modifier = Modifier
                                .size(24.dp, 16.dp)
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.Mic,
                            contentDescription = "Voice Dictation",
                            tint = if (isVoiceListening) palette.accent else palette.secondary,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }

                Spacer(modifier = Modifier.width(8.dp))

                // Morphing Send / Stop Circular Action Button
                Surface(
                    onClick = {
                        if (isStreaming) {
                            onStop()
                        } else if (canSend) {
                            onSend()
                        }
                    },
                    enabled = (canSend || isStreaming) && !isReadOnly,
                    shape = CircleShape,
                    color = when {
                        isStreaming -> palette.danger
                        canSend -> palette.accent
                        else -> palette.canvas.copy(alpha = 0.6f)
                    },
                    modifier = Modifier
                        .size(36.dp)
                        .tactilePress {
                            if (isStreaming) onStop() else if (canSend) onSend()
                        }
                ) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier.fillMaxSize()
                    ) {
                        AnimatedContent(
                            targetState = isStreaming,
                            transitionSpec = {
                                (scaleIn(AidenMotion.spatialExpressiveSpring<Float>()) + fadeIn(AidenMotion.nonSpatialExpressiveSpring<Float>()))
                                    .togetherWith(scaleOut(AidenMotion.spatialExpressiveSpring<Float>()) + fadeOut(AidenMotion.nonSpatialExpressiveSpring<Float>()))
                            },
                            label = "send_stop_morph"
                        ) { streaming ->
                            if (streaming) {
                                Icon(
                                    imageVector = Icons.Default.Stop,
                                    contentDescription = "Stop generation",
                                    tint = Color.White,
                                    modifier = Modifier.size(16.dp)
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Default.ArrowUpward,
                                    contentDescription = "Send message",
                                    tint = if (canSend) Color.White else palette.secondary.copy(alpha = 0.4f),
                                    modifier = Modifier.size(18.dp)
                                )
                            }
                        }
                    }
                }
            }

            // Voice Error Hint if applicable
            if (voiceErrorMessage != null && !isVoiceListening) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = voiceErrorMessage,
                    style = MaterialTheme.typography.labelSmall,
                    color = palette.danger,
                    modifier = Modifier.padding(start = 4.dp)
                )
            }
        }
    }
}
