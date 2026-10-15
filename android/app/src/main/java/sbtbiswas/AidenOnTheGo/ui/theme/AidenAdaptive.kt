package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Aiden's window width buckets, following the Material 3 window size classes:
 * phones in portrait are [Compact], small tablets and unfolded foldables in
 * portrait are [Medium], and tablets, large foldables, and desktop windows are
 * [Expanded]. Larger M3 classes collapse into [Expanded] because no Aiden layout
 * changes beyond it.
 */
enum class AidenWindowWidthClass {
    Compact,
    Medium,
    Expanded;

    companion object {
        val MediumMinWidth: Dp = 600.dp
        val ExpandedMinWidth: Dp = 840.dp

        fun forWidth(width: Dp): AidenWindowWidthClass = when {
            width < MediumMinWidth -> Compact
            width < ExpandedMinWidth -> Medium
            else -> Expanded
        }
    }
}

/**
 * Overrides the window width class for a subtree, for previews and tests. Left
 * unset, [currentAidenWindowWidthClass] reads the real window.
 */
val LocalAidenWindowClass = compositionLocalOf<AidenWindowWidthClass?> { null }

/** The width class of the window the composition is in, honoring [LocalAidenWindowClass]. */
@Composable
fun currentAidenWindowWidthClass(): AidenWindowWidthClass =
    LocalAidenWindowClass.current
        ?: AidenWindowWidthClass.forWidth(currentWindowAdaptiveInfo().windowSizeClass.minWidthDp.dp)

/**
 * Longest comfortable line for transcripts, lists, and forms (M3 recommends
 * 840–1040dp; this matches the desktop's default chat width).
 */
val AidenReadableMaxWidth: Dp = 840.dp

/**
 * Caps content at [maxWidth] and centers it in the space it is given. Below the
 * cap the content fills that space exactly as before, so phone layouts do not
 * change; on wide windows lines stop stretching edge to edge. It follows the
 * measured space rather than the window class, so split-screen and multi-pane
 * hosts get the right answer too.
 *
 * Put it after modifiers that should stay full width (backgrounds, system bar
 * insets) and before ones that belong to the content (gutters, scroll).
 */
fun Modifier.aidenReadableWidth(maxWidth: Dp = AidenReadableMaxWidth): Modifier = this
    .fillMaxWidth()
    .wrapContentWidth(Alignment.CenterHorizontally)
    .widthIn(max = maxWidth)
    .fillMaxWidth()
