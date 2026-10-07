package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/** How long the copy pill reads "Copied" before it reverts. */
internal const val AIDEN_CODE_COPY_CONFIRMATION_MS = 2_000L

/**
 * Syntax-styled code container with header bar, language label, and a copy pill that
 * morphs to a "Copied" confirmation and reverts.
 */
@Composable
fun AidenCodeBlock(
    code: String,
    language: String?,
    palette: AidenPalette,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var copyCount by remember { mutableIntStateOf(0) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copyCount) {
        if (copyCount > 0) {
            copied = true
            delay(AIDEN_CODE_COPY_CONFIRMATION_MS)
            copied = false
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth()
    ) {
        Column {
            // Header Bar
            Surface(
                color = palette.raised,
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = language?.uppercase()?.ifEmpty { "CODE" } ?: "CODE",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = palette.secondary
                    )
                    AidenCodeCopyPill(
                        copied = copied,
                        palette = palette,
                        onClick = {
                            onCopy(code)
                            copyCount++
                        }
                    )
                }
            }

            // Code Content
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(14.dp)
            ) {
                Text(
                    text = code,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    color = palette.foreground
                )
            }
        }
    }
}

@Composable
private fun AidenCodeCopyPill(
    copied: Boolean,
    palette: AidenPalette,
    onClick: () -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(
        targetValue = if (copied) palette.success.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "copy_pill_fill"
    )
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = fill,
        interactionSource = interaction,
        modifier = Modifier
            .tactilePress(interaction)
            .semantics {
                role = Role.Button
                contentDescription = if (copied) "Copied" else "Copy code"
                liveRegion = LiveRegionMode.Polite
            }
    ) {
        AnimatedContent(
            targetState = copied,
            transitionSpec = {
                fadeIn(AidenMotion.nonSpatial(reduceMotion)) togetherWith fadeOut(AidenMotion.nonSpatial(reduceMotion))
            },
            label = "copy_pill_content",
            modifier = Modifier
                .animateContentSize(AidenMotion.spatial(reduceMotion))
                .clearAndSetSemantics { }
        ) { isCopied ->
            Row(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp)
            ) {
                val ink = if (isCopied) palette.success else palette.secondary
                Icon(
                    imageVector = if (isCopied) Icons.Default.Check else Icons.Default.ContentCopy,
                    contentDescription = null,
                    tint = ink,
                    modifier = Modifier.size(14.dp)
                )
                Text(
                    text = if (isCopied) "Copied" else "Copy",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = ink
                )
            }
        }
    }
}
