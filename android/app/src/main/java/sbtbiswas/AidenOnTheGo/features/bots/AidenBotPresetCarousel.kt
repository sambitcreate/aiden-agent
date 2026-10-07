package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenBotPreset
import sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi

object AidenBotPresetCopy {
    const val TITLE = "Meet Your First Bot"
    const val START_CHAT = "Start Chat"
    const val CREATE_MY_OWN = "Create My Own"
}

/** Empty Bots home: a paged carousel of starter Bots with Start Chat and Create My Own. */
@Composable
fun AidenMeetYourFirstBot(
    presets: List<AidenBotPreset>,
    startingPresetId: String?,
    onStartChat: (AidenBotPreset) -> Unit,
    onCreateMyOwn: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val pager = rememberPagerState { presets.size }
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            AidenBotPresetCopy.TITLE,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground
        )
        Spacer(Modifier.height(16.dp))
        HorizontalPager(
            state = pager,
            contentPadding = PaddingValues(horizontal = 36.dp),
            pageSpacing = 12.dp,
            modifier = Modifier.fillMaxWidth()
        ) { page ->
            AidenBotPresetCard(presets[page])
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            presets.indices.forEach { index ->
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(if (index == pager.currentPage) palette.foreground else palette.secondary.copy(alpha = 0.35f))
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        val current = presets.getOrNull(pager.currentPage)
        Column(
            Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AidenPrimaryButton(
                text = AidenBotPresetCopy.START_CHAT,
                enabled = current != null && startingPresetId == null,
                onClick = { current?.let(onStartChat) },
                modifier = Modifier.fillMaxWidth()
            )
            AidenTonalButton(
                text = AidenBotPresetCopy.CREATE_MY_OWN,
                onClick = onCreateMyOwn,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun AidenBotPresetCard(preset: AidenBotPreset) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            Modifier.padding(20.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            AidenBotSemanticAvatarView(
                avatar = AidenBotSemanticAvatar.Recipe(preset.avatar),
                name = preset.name,
                size = 88.dp
            )
            Text(preset.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = palette.foreground)
            if (preset.subtitle.isNotBlank()) {
                Text(preset.subtitle, style = MaterialTheme.typography.bodyMedium, color = palette.secondary, textAlign = TextAlign.Center)
            }
            if (preset.suggestedConnections.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    preset.suggestedConnections.forEach { chip ->
                        AidenBotConnectionIcon(chip.iconId, chip.name, size = 32.dp)
                    }
                }
            }
            preset.suggestedRoutine?.let { routine ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Schedule, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("${routine.name} · ${routine.label}", style = MaterialTheme.typography.labelMedium, color = palette.secondary)
                }
            }
        }
    }
}
