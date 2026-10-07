package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Surface
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSectionLabel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/**
 * Model & Thinking sheet opened from the composer's model pill. Thinking effort is a
 * connected segmented selector (or a connected radio list for long ladders) that applies
 * in place; picking a model applies it and closes the sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AidenComposerModelSheet(
    availableProviders: List<AidenProvider>,
    selectedProvider: AidenProvider?,
    selectedModel: AidenModel?,
    selectedThinkingLevel: String?,
    onSelectModel: (AidenProvider, AidenModel, String?) -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val thinkingLevels = selectedModel?.thinkingLevels.orEmpty()
    val thinkingSelector = if (selectedProvider != null && selectedModel != null) {
        aidenComposerThinkingSelector(thinkingLevels)
    } else {
        AidenComposerThinkingSelector.NONE
    }
    val sections = aidenComposerModelSections(availableProviders, selectedProvider, selectedModel)

    fun close() {
        if (reduceMotion) {
            onDismiss()
        } else {
            scope.launch { sheetState.hide() }.invokeOnCompletion {
                if (!sheetState.isVisible) onDismiss()
            }
        }
    }

    val sheetBody: @Composable () -> Unit = {
        Column(
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AidenUi.ScreenGutter)
                .padding(bottom = 28.dp)
        ) {
            Text(
                text = if (thinkingSelector == AidenComposerThinkingSelector.NONE) "Model" else "Model & Thinking",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = palette.foreground
            )

            if (thinkingSelector != AidenComposerThinkingSelector.NONE && selectedProvider != null && selectedModel != null) {
                Spacer(Modifier.height(4.dp))
                AidenSectionLabel("Thinking")
                val current = aidenComposerSelectedThinkingLevel(selectedModel, selectedThinkingLevel)
                val pickLevel: (String) -> Unit = { level -> onSelectModel(selectedProvider, selectedModel, level) }
                if (thinkingSelector == AidenComposerThinkingSelector.SEGMENTED && current != null) {
                    AidenSegmentedPillRow(
                        options = thinkingLevels,
                        selected = current,
                        onSelect = pickLevel,
                        label = { selectedModel.thinkingLabel(it) }
                    )
                } else {
                    AidenConnectedColumn(modifier = Modifier.selectableGroup()) {
                        thinkingLevels.forEachIndexed { index, level ->
                            AidenComposerRadioCard(
                                index = index,
                                count = thinkingLevels.size,
                                selected = level == current,
                                onClick = { if (level != current) pickLevel(level) }
                            ) {
                                Text(
                                    text = selectedModel.thinkingLabel(level),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                            }
                        }
                    }
                }
            }

            sections.forEach { section ->
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AidenProviderIcon(
                        providerId = section.provider.id,
                        providerLabel = section.provider.label,
                        artwork = section.provider.artwork,
                        size = 16.dp
                    )
                    Spacer(Modifier.width(8.dp))
                    AidenSectionLabel(section.provider.label)
                }
                AidenConnectedColumn(modifier = Modifier.selectableGroup()) {
                    section.rows.forEachIndexed { index, row ->
                        AidenComposerRadioCard(
                            index = index,
                            count = section.rows.size,
                            selected = row.isCurrent,
                            onClick = {
                                onSelectModel(section.provider, row.model, null)
                                close()
                            }
                        ) {
                            Text(
                                text = row.model.label,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = if (row.isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                                color = palette.foreground,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }
                }
            }
        }
    }

    // Material's sheet motion cannot follow Aiden's Reduce Motion preference, so reduced
    // motion presents the same content in a still sheet with no slide or predictive back.
    if (reduceMotion) {
        AidenStillBottomSheet(onDismiss = onDismiss, containerColor = palette.raised) { sheetBody() }
    } else {
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
            containerColor = palette.raised
        ) {
            sheetBody()
        }
    }
}

/**
 * Bottom sheet without motion: appears and dismisses instantly, and system back or a scrim
 * tap closes it without the predictive-back shrink. Used when motion is reduced.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AidenStillBottomSheet(
    onDismiss: () -> Unit,
    containerColor: Color,
    content: @Composable () -> Unit
) {
    val maxSheetHeight = (LocalConfiguration.current.screenHeightDp * 0.9f).dp
    Popup(
        alignment = Alignment.BottomCenter,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(BottomSheetDefaults.ScrimColor)
                .clickable(interactionSource = null, indication = null, onClickLabel = "Close sheet", onClick = onDismiss)
                .testTag(AidenStillBottomSheetTag),
            contentAlignment = Alignment.BottomCenter
        ) {
            Surface(
                shape = BottomSheetDefaults.ExpandedShape,
                color = containerColor,
                modifier = Modifier
                    .widthIn(max = BottomSheetDefaults.SheetMaxWidth)
                    .fillMaxWidth()
                    .heightIn(max = maxSheetHeight)
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBars)
                ) {
                    BottomSheetDefaults.DragHandle()
                    content()
                }
            }
        }
    }
}

internal const val AidenStillBottomSheetTag = "aiden.sheet.still"

/** Connected group card announced as a radio choice; selection is the radio plus a tonal fill. */
@Composable
private fun AidenComposerRadioCard(
    index: Int,
    count: Int,
    selected: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit
) {
    val palette = AidenTheme.palette
    AidenGroupCard(
        index = index,
        count = count,
        selected = selected,
        onClick = onClick,
        role = Role.RadioButton,
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.semantics { this.selected = selected }
    ) {
        content()
        RadioButton(
            selected = selected,
            onClick = null,
            colors = RadioButtonDefaults.colors(
                selectedColor = palette.accent,
                unselectedColor = palette.secondary
            )
        )
    }
}
