package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenQuestionnaireRecap

/** Recap cards take at most this share of the transcript width, like the desktop. */
private const val RECAP_MAX_WIDTH_FRACTION = 0.8f

/**
 * A settled questionnaire in the transcript: each question with the owner's
 * choice beneath it, end-aligned like the owner's own messages.
 */
@Composable
internal fun AidenQuestionnaireRecapStack(
    recap: AidenQuestionnaireRecap,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    val stackDescription = stringResource(R.string.chat_questionnaire_recap_cd)
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) {
        Column(
            modifier = Modifier
                .fillMaxWidth(RECAP_MAX_WIDTH_FRACTION)
                .semantics {
                    contentDescription = stackDescription
                    heading()
                },
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            recap.items.forEach { item ->
                AidenQuestionnaireRecapCard(item = item, answer = recap.answer(item), palette = palette)
            }
        }
    }
}

@Composable
private fun AidenQuestionnaireRecapCard(
    item: AidenQuestionnaireRecap.Item,
    answer: AidenQuestionnaireRecap.Answer,
    palette: AidenPalette
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        // One stop for screen readers: the question, then the answer.
        modifier = Modifier.semantics(mergeDescendants = true) {}
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(
                text = item.question,
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary
            )
            val answerModifier = Modifier.padding(top = 4.dp)
            when (answer) {
                is AidenQuestionnaireRecap.Answer.Choice -> Text(
                    text = answer.text,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.foreground,
                    modifier = answerModifier
                )
                is AidenQuestionnaireRecap.Answer.Custom -> Text(
                    text = stringResource(R.string.chat_questionnaire_custom_answer, answer.text),
                    style = MaterialTheme.typography.bodyMedium,
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
                    style = MaterialTheme.typography.bodyMedium,
                    color = palette.secondary,
                    modifier = answerModifier
                )
            }
        }
    }
}
