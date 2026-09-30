package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenChatRowState

/** Semantic tone for a row-status pill; resolved against the active palette. */
enum class AidenChatRowStatusTone { WARNING, ACCENT }

/** What a chat row's trailing status shows, independent of Compose. */
data class AidenChatRowStatusPresentation(
    val pillTitle: String?,
    val pillTone: AidenChatRowStatusTone?,
    val showsSpinner: Boolean,
    val showsUnreadDot: Boolean,
    /** Spoken summary for the whole status, or null when nothing is shown. */
    val contentDescription: String?
) {
    companion object {
        fun of(state: AidenChatRowState, unread: Boolean): AidenChatRowStatusPresentation {
            val (title, tone) = when (state) {
                AidenChatRowState.NEEDS_APPROVAL -> "Approve" to AidenChatRowStatusTone.WARNING
                AidenChatRowState.NEEDS_INPUT -> "Reply" to AidenChatRowStatusTone.ACCENT
                AidenChatRowState.WORKING, AidenChatRowState.IDLE -> null to null
            }
            val spoken = listOfNotNull(
                state.accessibilityLabel.takeIf { state != AidenChatRowState.IDLE },
                "Unread".takeIf { unread }
            )
            return AidenChatRowStatusPresentation(
                pillTitle = title,
                pillTone = tone,
                showsSpinner = state == AidenChatRowState.WORKING,
                showsUnreadDot = unread,
                contentDescription = spoken.joinToString(", ").ifEmpty { null }
            )
        }
    }
}

/**
 * Trailing chat-row status. Attention states use soft semantic fills with no
 * borders, Working keeps a compact spinner, and the unread dot is independent
 * because a chat can be working while holding unseen earlier output.
 */
@Composable
fun AidenChatRowStatus(state: AidenChatRowState, unread: Boolean, palette: AidenPalette) {
    val presentation = AidenChatRowStatusPresentation.of(state, unread)
    val description = presentation.contentDescription ?: return
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.clearAndSetSemantics { contentDescription = description }
    ) {
        val title = presentation.pillTitle
        val tone = presentation.pillTone
        if (title != null && tone != null) {
            val tint: Color = when (tone) {
                AidenChatRowStatusTone.WARNING -> palette.warning
                AidenChatRowStatusTone.ACCENT -> palette.accent
            }
            Text(
                title,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = tint,
                modifier = Modifier
                    .background(tint.copy(alpha = 0.12f), RoundedCornerShape(50))
                    .padding(horizontal = 8.dp, vertical = 3.dp)
            )
        }
        if (presentation.showsSpinner) {
            CircularProgressIndicator(
                color = palette.accent,
                strokeWidth = 2.dp,
                modifier = Modifier.size(16.dp)
            )
        }
        if (presentation.showsUnreadDot) {
            Box(Modifier.size(8.dp).background(palette.accent, CircleShape))
        }
    }
}
