package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMark
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityLevel
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/** How often a playing preview checks the shared clock. */
private const val PREVIEW_TICK_MILLIS = 200L

/**
 * A small chat replaying one scripted turn, as [level] shows it on the Mac.
 *
 * Every preview reads the same wall clock, so the ones on a page are on the same step of the
 * turn. It holds still, with no Play control, under Reduce Motion (system or in-app) on the
 * level's still frame; it pauses while the app isn't in front or the preview is scrolled out
 * of view. The marks pause with it.
 *
 * Pass [description] for a standalone preview. Left null, the preview is decoration hidden
 * from TalkBack: the choice row it sits in already speaks the title and detail.
 */
@Composable
fun AidenBotChatActivityPreviewCard(
    level: AidenBotChatActivityLevel,
    wording: AidenBotChatActivityWording,
    modifier: Modifier = Modifier,
    description: String? = null
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val resumed = aidenBotIsResumed()
    var onScreen by remember { mutableStateOf(true) }
    val playing = AidenBotChatActivityPreview.plays(reduceMotion, resumed, onScreen)
    var index by remember { mutableIntStateOf(AidenBotChatActivityPreview.stillFrame(level)) }
    LaunchedEffect(level, reduceMotion, playing) {
        index = AidenBotChatActivityPreview.shownFrame(level, reduceMotion, playing, index, System.currentTimeMillis())
        while (playing) {
            delay(PREVIEW_TICK_MILLIS)
            index = AidenBotChatActivityPreview.shownFrame(level, reduceMotion, playing, index, System.currentTimeMillis())
        }
    }
    val frame = AidenBotChatActivityPreview.frame(index, level)
    val markSize = with(LocalDensity.current) { 14.sp.toDp() }
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = modifier
            .fillMaxWidth()
            .onGloballyPositioned { coordinates ->
                onScreen = coordinates.isAttached && coordinates.findRootCoordinates().boundsInWindow().overlaps(coordinates.boundsInWindow())
            }
            .clip(MaterialTheme.shapes.medium)
            .background(palette.canvas)
            .padding(10.dp)
            .clearAndSetSemantics { if (description != null) contentDescription = description }
    ) {
        Text(
            stringResource(R.string.bot_chat_activity_preview_prompt),
            style = MaterialTheme.typography.labelMedium,
            color = palette.foreground,
            modifier = Modifier
                .align(Alignment.End)
                .clip(MaterialTheme.shapes.small)
                .background(palette.raised)
                .padding(horizontal = 10.dp, vertical = 6.dp)
        )
        if (frame.recapShown) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (frame.recapOpen) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier.size(markSize)
                )
                Text(stringResource(R.string.bot_chat_activity_preview_recap), style = MaterialTheme.typography.labelSmall, color = palette.secondary)
            }
        }
        frame.steps.forEach { step ->
            Text(stringResource(step), style = MaterialTheme.typography.labelSmall, color = palette.secondary, modifier = Modifier.padding(start = 14.dp))
        }
        frame.running?.let { running ->
            Text(
                stringResource(running),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                color = palette.foreground,
                modifier = Modifier.padding(start = 14.dp)
            )
        }
        val phase = frame.phase
        if (phase != null) {
            val shown = aidenBotActivityDisplay(phase, wording, null)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AidenActivityMark(mark = shown.mark, size = markSize, active = playing, color = palette.secondary)
                Text(shown.word(), style = MaterialTheme.typography.labelMedium, color = palette.secondary)
            }
        } else {
            Text(stringResource(R.string.bot_chat_activity_preview_reply), style = MaterialTheme.typography.labelMedium, color = palette.foreground)
        }
    }
}
