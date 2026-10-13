package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenQuestionnaireRecap
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenGroupItemShape
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/** Recap cards take at most this share of the transcript width, like the desktop. */
private const val RECAP_MAX_WIDTH_FRACTION = 0.8f

/** Scale a recap grows from when it first lands in a live reply. */
private const val RECAP_ENTER_SCALE = 0.92f

/**
 * A settled questionnaire in the transcript: each question with the owner's
 * choice beneath it, end-aligned like the owner's own messages. The cards form
 * one Material 3 Expressive connected group: borderless tonal fills, outer
 * corners on the group's edges and narrow seams between answers.
 *
 * With [animateEntrance], used while a reply is still running, the group
 * springs in from its trailing corner the first time it appears; it holds
 * still under reduced motion.
 */
@Composable
internal fun AidenQuestionnaireRecapStack(
    recap: AidenQuestionnaireRecap,
    palette: AidenPalette,
    modifier: Modifier = Modifier,
    animateEntrance: Boolean = false
) {
    val stackDescription = stringResource(R.string.chat_questionnaire_recap_cd)
    val reduceMotion = aidenReduceMotion()
    val visibility = remember { MutableTransitionState(!animateEntrance).apply { targetState = true } }
    val trailingEdge = if (LocalLayoutDirection.current == LayoutDirection.Rtl) 0f else 1f
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) {
        AnimatedVisibility(
            visibleState = visibility,
            enter = fadeIn(AidenMotion.short(reduceMotion)) + scaleIn(
                animationSpec = AidenMotion.spatial(reduceMotion),
                initialScale = RECAP_ENTER_SCALE,
                transformOrigin = TransformOrigin(trailingEdge, 0f)
            ),
            modifier = Modifier.fillMaxWidth(RECAP_MAX_WIDTH_FRACTION)
        ) {
            AidenConnectedColumn(
                modifier = Modifier.semantics {
                    contentDescription = stackDescription
                    heading()
                }
            ) {
                recap.items.forEachIndexed { index, item ->
                    AidenQuestionnaireRecapCard(
                        item = item,
                        answer = recap.answer(item),
                        index = index,
                        count = recap.items.size,
                        palette = palette
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenQuestionnaireRecapCard(
    item: AidenQuestionnaireRecap.Item,
    answer: AidenQuestionnaireRecap.Answer,
    index: Int,
    count: Int,
    palette: AidenPalette
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = aidenGroupItemShape(index, count),
        // One stop for screen readers: the question, then the answer.
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {}
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(
                text = item.question,
                style = MaterialTheme.typography.labelMedium,
                color = palette.secondary
            )
            val answerModifier = Modifier.padding(top = 4.dp)
            when (answer) {
                is AidenQuestionnaireRecap.Answer.Choice -> Text(
                    text = answer.text,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    modifier = answerModifier
                )
                is AidenQuestionnaireRecap.Answer.Custom -> Text(
                    text = stringResource(R.string.chat_questionnaire_custom_answer, answer.text),
                    style = MaterialTheme.typography.bodyLarge,
                    color = palette.foreground,
                    modifier = answerModifier
                )
                is AidenQuestionnaireRecap.Answer.Unanswered -> Text(
                    text = stringResource(
                        when (answer.outcome) {
                            AidenQuestionnaireRecap.Outcome.ANSWERED -> R.string.chat_questionnaire_skipped
                            AidenQuestionnaireRecap.Outcome.DISMISSED -> R.string.chat_questionnaire_dismissed
                            AidenQuestionnaireRecap.Outcome.EXPIRED -> R.string.chat_questionnaire_no_answer
                        }
                    ),
                    style = MaterialTheme.typography.bodyLarge,
                    color = palette.secondary,
                    modifier = answerModifier
                )
            }
        }
    }
}
