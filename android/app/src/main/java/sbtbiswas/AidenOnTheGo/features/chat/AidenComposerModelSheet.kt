package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerSheet
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.features.shared.toModelPickerProvider
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSectionLabel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Model & Thinking sheet opened from the composer's model pill, built on the shared
 * model picker. Thinking effort sits under the current-model summary as a connected
 * segmented selector (or a connected radio list for long ladders) and applies in place;
 * picking a model applies it and closes the sheet. When the chat has no listed model it
 * runs on the Mac's default, which the picker shows as a checked Default row.
 */
@Composable
internal fun AidenComposerModelSheet(
    availableProviders: List<AidenProvider>,
    selectedProvider: AidenProvider?,
    selectedModel: AidenModel?,
    selectedThinkingLevel: String?,
    onSelectModel: (AidenProvider, AidenModel, String?) -> Unit,
    onDismiss: () -> Unit,
    defaultRoute: AidenModelRoute? = null,
    recentRoutes: List<AidenModelRoute> = emptyList()
) {
    val palette = AidenTheme.palette
    val thinkingLevels = selectedModel?.thinkingLevels.orEmpty()
    val thinkingSelector = if (selectedProvider != null && selectedModel != null) {
        aidenComposerThinkingSelector(thinkingLevels)
    } else {
        AidenComposerThinkingSelector.NONE
    }
    val pickerProviders = remember(availableProviders) { availableProviders.map { it.toModelPickerProvider() } }
    val selection = if (selectedProvider != null && selectedModel != null) {
        AidenModelRoute(selectedProvider.id, selectedModel.id)
    } else null

    AidenModelPickerSheet(
        title = stringResource(
            if (thinkingSelector == AidenComposerThinkingSelector.NONE) R.string.model_picker_title
            else R.string.model_picker_title_with_thinking
        ),
        providers = pickerProviders,
        selection = selection,
        onSelect = { entry ->
            val provider = availableProviders.firstOrNull { it.id == entry.provider.id }
            val model = provider?.models?.firstOrNull { it.id == entry.model.id }
            if (provider != null && model != null) onSelectModel(provider, model, null)
        },
        onDismiss = onDismiss,
        defaultRoute = defaultRoute,
        allowsDefault = true,
        recentRoutes = recentRoutes
    ) {
        if (thinkingSelector != AidenComposerThinkingSelector.NONE && selectedProvider != null && selectedModel != null) {
            Spacer(Modifier.height(8.dp))
            AidenSectionLabel(stringResource(R.string.model_picker_thinking))
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
    }
}

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
