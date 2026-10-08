package sbtbiswas.AidenOnTheGo.features.settings

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Animation
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceMode
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenFontSize
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenPresetPalette
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/** Appearance: mode, theme, text size, and motion. Changes apply immediately and persist. */
@Composable
fun AidenAppearanceSettingsScreen(
    appearanceStore: AidenAppearanceStore,
    onNavigateBack: () -> Unit
) {
    val config = AidenTheme.config
    AidenSettingsScaffold(
        title = stringResource(R.string.settings_appearance),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "mode") {
            AidenSettingsGroup(title = stringResource(R.string.appearance_group_mode)) {
                row(dividerInset = 0.dp) {
                    val modeDescription = stringResource(R.string.appearance_mode_description)
                    AidenSegmentedPillRow(
                        options = AidenAppearanceMode.entries,
                        selected = config.mode,
                        onSelect = appearanceStore::updateMode,
                        label = { it.title },
                        segmentContentDescription = { String.format(modeDescription, it.title) },
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
        item(key = "theme") {
            AidenSettingsGroup(title = stringResource(R.string.appearance_group_theme)) {
                row(dividerInset = 0.dp) {
                    AidenThemeTileGrid(
                        selected = config.preset,
                        onSelect = appearanceStore::updatePreset,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
        item(key = "text-size") {
            AidenSettingsGroup(title = stringResource(R.string.appearance_group_text_size), selectableGroup = true) {
                AidenFontSize.entries.forEach { size ->
                    row(dividerInset = AidenSettingsDefaults.DividerInsetWithIcon) {
                        AidenSettingsRadioRow(
                            headline = size.title,
                            selected = config.fontSize == size,
                            onClick = { appearanceStore.updateFontSize(size) }
                        )
                    }
                }
            }
        }
        item(key = "motion") {
            AidenSettingsGroup(title = stringResource(R.string.appearance_group_motion)) {
                row {
                    AidenSettingsSwitchRow(
                        headline = stringResource(R.string.appearance_reduce_motion),
                        supporting = stringResource(R.string.appearance_reduce_motion_supporting),
                        checked = config.reduceMotion,
                        leadingIcon = Icons.Outlined.Animation,
                        onCheckedChange = appearanceStore::updateReduceMotion
                    )
                }
            }
        }
    }
}

/** Theme presets this device can show, three per row. Dynamic color appears on Android 12+. */
@Composable
internal fun AidenThemeTileGrid(
    selected: AidenThemePresetID,
    onSelect: (AidenThemePresetID) -> Unit,
    modifier: Modifier = Modifier,
    presets: List<AidenThemePresetID> = AidenThemePresetID.available(Build.VERSION.SDK_INT)
) {
    Column(
        modifier = modifier.selectableGroup(),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        presets.chunked(3).forEach { rowPresets ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                rowPresets.forEach { preset ->
                    AidenThemeTile(
                        preset = preset,
                        selected = selected == preset,
                        onClick = { if (selected != preset) onSelect(preset) },
                        modifier = Modifier.weight(1f)
                    )
                }
                repeat(3 - rowPresets.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** Scheme whose palette visually defines this preset on its tile. */
private val AidenThemePresetID.signatureIsDark: Boolean
    get() = this == AidenThemePresetID.GRAPHITE || this == AidenThemePresetID.DUSK || this == AidenThemePresetID.MIDNIGHT

/**
 * One theme choice. The tile is a single radio button for accessibility services: its
 * name, selection, and click are set on the tile and the decorative preview is cleared.
 * Selection shows as a check badge inside the preview and a tonal label, never a border.
 */
@Composable
private fun AidenThemeTile(
    preset: AidenThemePresetID,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val previewDark = if (preset.isDynamic) palette.canvas.luminance() < 0.5f else preset.signatureIsDark
    val preview = aidenPresetPalette(preset, previewDark)
    val interaction = remember { MutableInteractionSource() }
    Column(
        modifier = modifier
            .clip(MaterialTheme.shapes.medium)
            .selectable(
                selected = selected,
                role = Role.RadioButton,
                interactionSource = interaction,
                indication = ripple(),
                onClick = onClick
            )
            .clearAndSetSemantics {
                contentDescription = preset.title
                this.selected = selected
                role = Role.RadioButton
                onClick { onClick(); true }
            },
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1.5f)
                .tactilePress(interaction)
                .clip(MaterialTheme.shapes.medium)
                .background(preview.canvas)
        ) {
            Text(
                text = "Aa",
                style = MaterialTheme.typography.headlineMedium,
                color = preview.foreground,
                modifier = Modifier.align(Alignment.Center)
            )
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(8.dp)
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(preview.accent)
            )
            if (selected) {
                Surface(
                    color = palette.accent,
                    contentColor = palette.onAccent,
                    shape = CircleShape,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .size(20.dp)
                ) {
                    Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.padding(3.dp))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            text = preset.title,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = if (selected) palette.foreground else palette.secondary,
            modifier = Modifier
                .clip(MaterialTheme.shapes.small)
                .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                .padding(horizontal = 8.dp, vertical = 2.dp)
        )
        Spacer(Modifier.height(4.dp))
    }
}
