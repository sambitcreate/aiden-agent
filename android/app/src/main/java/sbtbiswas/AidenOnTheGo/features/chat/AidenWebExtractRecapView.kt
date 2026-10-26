package sbtbiswas.AidenOnTheGo.features.chat

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenWebExtractRecap

/** The same words the desktop card uses for each failure. */
@StringRes
internal fun AidenWebExtractRecap.Failure.messageRes(): Int = when (this) {
    AidenWebExtractRecap.Failure.SETUP -> R.string.chat_web_extract_error_setup
    AidenWebExtractRecap.Failure.AUTH -> R.string.chat_web_extract_error_auth
    AidenWebExtractRecap.Failure.QUOTA -> R.string.chat_web_extract_error_quota
    AidenWebExtractRecap.Failure.TIMEOUT -> R.string.chat_web_extract_error_timeout
    AidenWebExtractRecap.Failure.UNAVAILABLE -> R.string.chat_web_extract_error_unavailable
    AidenWebExtractRecap.Failure.INVALID_RESPONSE -> R.string.chat_web_extract_error_invalid_response
}

/**
 * The values a `web_fetch` extract call read, under its activity line: each
 * name and value with the page line it came from, so the owner can check a
 * number against its source without opening the page. Guesses and values the
 * page does not have are labelled as such, never shown as read. A borderless
 * tonal card like the tool lines it follows.
 */
@Composable
internal fun AidenWebExtractRecapCard(
    recap: AidenWebExtractRecap,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    val description = stringResource(R.string.chat_web_extract_recap_cd, recap.host)
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = description }
    ) {
        SelectionContainer {
            Column(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(
                        imageVector = Icons.Outlined.Language,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier.size(14.dp)
                    )
                    Text(
                        text = recap.host,
                        style = MaterialTheme.typography.labelMedium,
                        color = palette.secondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                val failure = recap.error
                if (failure != null) {
                    Text(
                        text = stringResource(R.string.chat_web_extract_failed, stringResource(failure.messageRes())),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                } else {
                    recap.fields.forEach { field -> AidenWebExtractFieldRow(field, palette) }
                }
                if (recap.cut) {
                    Text(
                        text = stringResource(R.string.chat_web_extract_cut),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary.copy(alpha = 0.8f)
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenWebExtractFieldRow(field: AidenWebExtractRecap.Field, palette: AidenPalette) {
    // One stop for screen readers: the name, the value, then its source.
    Column(
        modifier = Modifier.semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Text(text = field.label, style = MaterialTheme.typography.labelMedium, color = palette.secondary)
        when (field.status) {
            AidenWebExtractRecap.Status.ABSENT -> Text(
                text = stringResource(R.string.chat_web_extract_absent),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary.copy(alpha = 0.8f)
            )
            AidenWebExtractRecap.Status.EXTRACTED -> Text(
                text = field.value.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = palette.foreground
            )
            AidenWebExtractRecap.Status.UNCERTAIN -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                field.value?.let { value ->
                    Text(
                        text = value,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.secondary,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                }
                Surface(color = palette.warning.copy(alpha = 0.14f), shape = MaterialTheme.shapes.extraLarge) {
                    Text(
                        text = stringResource(R.string.chat_web_extract_guess),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.warning,
                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp)
                    )
                }
            }
        }
        if (field.status != AidenWebExtractRecap.Status.ABSENT) {
            val sourceLine = field.sourceLine
            when {
                sourceLine != null -> Text(
                    text = stringResource(R.string.chat_web_extract_source_line, sourceLine),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary.copy(alpha = 0.8f)
                )
                field.notFound == true -> Text(
                    text = stringResource(R.string.chat_web_extract_not_found),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary.copy(alpha = 0.8f)
                )
            }
        }
    }
}
