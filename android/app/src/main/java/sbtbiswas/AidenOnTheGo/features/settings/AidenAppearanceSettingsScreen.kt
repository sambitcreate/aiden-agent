package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

@Composable
fun AidenAppearanceSettingsScreen(
    appearanceStore: AidenAppearanceStore? = null
) {
    val currentConfig = AidenTheme.config
    val palette = AidenTheme.palette

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(20.dp)
    ) {
        Text(
            text = "Appearance & Theme",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = palette.foreground
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Preset theme cards
        Text(
            text = "Theme Palette",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AidenThemePresetID.entries.forEach { preset ->
                val p = AidenThemeCatalog.palette(preset, false)
                Card(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .tactilePress { appearanceStore?.updatePreset(preset) },
                    colors = CardDefaults.cardColors(
                        containerColor = if (currentConfig.preset == preset) palette.raised else palette.canvas
                    ),
                    shape = RoundedCornerShape(12.dp),
                    border = if (currentConfig.preset == preset) CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(palette.accent)) else null
                ) {
                    Column(
                        modifier = Modifier.padding(10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Box(modifier = Modifier.size(14.dp).clip(CircleShape).background(p.accent))
                            Box(modifier = Modifier.size(14.dp).clip(CircleShape).background(p.secondary))
                        }
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = preset.title,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = palette.foreground
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Mode selector (System, Light, Dark)
        Text(
            text = "Mode",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AidenAppearanceMode.values().forEach { mode ->
                FilterChip(
                    selected = currentConfig.mode == mode,
                    onClick = { appearanceStore?.updateMode(mode) },
                    label = { Text(mode.title) },
                    modifier = Modifier.weight(1f)
                )
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Contrast slider
        Text(
            text = "Contrast (${currentConfig.contrast}%)",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Slider(
            value = currentConfig.contrast.toFloat(),
            onValueChange = { appearanceStore?.updateContrast(it.toInt()) },
            valueRange = 0f..100f,
            colors = SliderDefaults.colors(
                thumbColor = palette.accent,
                activeTrackColor = palette.accent
            )
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Font Size selector
        Text(
            text = "Text Size",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AidenFontSize.values().forEach { size ->
                FilterChip(
                    selected = currentConfig.fontSize == size,
                    onClick = { appearanceStore?.updateFontSize(size) },
                    label = { Text(size.title) }
                )
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Reduce Motion switch
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Reduce Motion",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground
                )
                Text(
                    text = "Minimize animated thinking orbs and transitions",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            }
            Switch(
                checked = currentConfig.reduceMotion,
                onCheckedChange = { appearanceStore?.updateReduceMotion(it) }
            )
        }
    }
}
