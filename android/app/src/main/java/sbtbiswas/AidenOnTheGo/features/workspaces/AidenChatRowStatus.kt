package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
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
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion

/**
 * Triage rank used to order chat lists, most urgent first. Mirrors the
 * desktop Inbox's Needs you tiers (`INBOX_TIERS`, with row status from
 * `inboxRowStatus`), which sit above its Updates and Earlier sections: a chat
 * blocked on the user outranks one that is merely working, and everything
 * else keeps its existing order.
 */
fun AidenChatRowState.attentionRank(): Int = when (this) {
    AidenChatRowState.NEEDS_APPROVAL -> 0
    AidenChatRowState.NEEDS_INPUT -> 1
    AidenChatRowState.WORKING -> 2
    AidenChatRowState.IDLE -> 3
}

/**
 * Triage rank for a whole row. Mirrors the desktop Inbox's Needs you tiers:
 * approval, input, then an idle chat whose unseen output is a failed turn
 * (it needs a look; a working chat needs nothing), then working, then the rest.
 */
fun AidenChatSummary.attentionRank(): Int {
    val state = displayRowState
    return when {
        state == AidenChatRowState.NEEDS_APPROVAL || state == AidenChatRowState.NEEDS_INPUT -> state.attentionRank()
        state == AidenChatRowState.IDLE && showsFailed -> 2
        else -> state.attentionRank() + 1
    }
}

/**
 * Moves chats that need the user, then unseen failures, then working chats,
 * ahead of idle ones. The sort is stable, so rows within a tier keep the
 * incoming (recency) order and do not jitter between refreshes.
 */
fun aidenNeedsAttentionFirst(chats: List<AidenChatSummary>): List<AidenChatSummary> =
    chats.sortedBy { it.attentionRank() }

/** Semantic tone for a row-status pill; resolved against the active palette. */
enum class AidenChatRowStatusTone { WARNING, ACCENT, DANGER }

/** What a chat row's trailing status shows, independent of Compose. */
data class AidenChatRowStatusPresentation(
    val pillTitle: String?,
    val pillTone: AidenChatRowStatusTone?,
    /** Working shows a breathing activity dot; Aiden never uses a spinner for it. */
    val showsActivity: Boolean,
    val showsUnreadDot: Boolean,
    /**
     * The unseen output is a failed turn: a soft danger Failed pill replaces
     * the unread dot so a failure never reads as a fresh reply.
     */
    val showsFailed: Boolean,
    /** Spoken summary for the whole status, or null when nothing is shown. */
    val contentDescription: String?
) {
    companion object {
        const val FAILED_TITLE = "Failed"

        fun of(
            state: AidenChatRowState,
            unread: Boolean,
            failed: Boolean = false
        ): AidenChatRowStatusPresentation {
            val showsFailed = unread && failed
            val (title, tone) = when (state) {
                AidenChatRowState.NEEDS_APPROVAL -> "Approve" to AidenChatRowStatusTone.WARNING
                AidenChatRowState.NEEDS_INPUT -> "Reply" to AidenChatRowStatusTone.ACCENT
                AidenChatRowState.WORKING, AidenChatRowState.IDLE -> null to null
            }
            val spoken = listOfNotNull(
                state.accessibilityLabel.takeIf { state != AidenChatRowState.IDLE },
                when {
                    showsFailed -> FAILED_TITLE
                    unread -> "Unread"
                    else -> null
                }
            )
            return AidenChatRowStatusPresentation(
                pillTitle = title,
                pillTone = tone,
                showsActivity = state == AidenChatRowState.WORKING,
                showsUnreadDot = unread && !showsFailed,
                showsFailed = showsFailed,
                contentDescription = spoken.joinToString(", ").ifEmpty { null }
            )
        }
    }
}

/**
 * Trailing chat-row status. Attention states use soft semantic fills with no
 * borders, Working shows a breathing activity dot, and the unread dot is independent
 * because a chat can be working while holding unseen earlier output. When that unseen
 * output is a failed turn, a soft danger Failed pill takes the dot's place. State changes
 * morph with a snappy spring; with reduced motion they swap instantly and the
 * Working dot holds still. The whole status is spoken once, for example "Working".
 */
@Composable
fun AidenChatRowStatus(
    state: AidenChatRowState,
    unread: Boolean,
    palette: AidenPalette,
    failed: Boolean = false
) {
    val presentation = AidenChatRowStatusPresentation.of(state, unread, failed)
    val description = presentation.contentDescription
    val reduceMotion = aidenReduceMotion()
    AnimatedContent(
        targetState = presentation,
        contentAlignment = Alignment.CenterEnd,
        transitionSpec = {
            (scaleIn(AidenMotion.snappy(reduceMotion), initialScale = 0.8f) +
                fadeIn(AidenMotion.nonSpatial(reduceMotion))) togetherWith
                (scaleOut(AidenMotion.snappy(reduceMotion), targetScale = 0.8f) +
                    fadeOut(AidenMotion.nonSpatial(reduceMotion))) using
                SizeTransform(clip = false) { _, _ -> AidenMotion.spatial(reduceMotion) }
        },
        label = "ChatRowStatus",
        modifier = Modifier.clearAndSetSemantics {
            if (description != null) contentDescription = description
        }
    ) { shown ->
        AidenChatRowStatusContent(shown, palette)
    }
}

@Composable
private fun AidenChatRowStatusContent(
    presentation: AidenChatRowStatusPresentation,
    palette: AidenPalette
) {
    if (presentation.contentDescription == null) return
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        val title = presentation.pillTitle
        val tone = presentation.pillTone
        if (title != null && tone != null) {
            val tint: Color = when (tone) {
                AidenChatRowStatusTone.WARNING -> palette.warning
                AidenChatRowStatusTone.ACCENT -> palette.accent
                AidenChatRowStatusTone.DANGER -> palette.danger
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
        if (presentation.showsActivity) {
            // A soft ring keeps the working dot distinct from the solid unread dot beside it.
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(16.dp).background(palette.accent.copy(alpha = 0.14f), CircleShape)
            ) {
                AidenActivityDot(color = palette.accent, size = 8.dp)
            }
        }
        if (presentation.showsFailed) {
            // Same soft 12% semantic fill as the attention pills, with no border.
            val tint = palette.danger
            Row(
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .background(tint.copy(alpha = 0.12f), RoundedCornerShape(50))
                    .padding(start = 6.dp, end = 8.dp, top = 3.dp, bottom = 3.dp)
            ) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
                Text(
                    AidenChatRowStatusPresentation.FAILED_TITLE,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = tint
                )
            }
        }
        if (presentation.showsUnreadDot) {
            Box(Modifier.size(8.dp).background(palette.accent, CircleShape))
        }
    }
}
