package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenBrowserBreadcrumb
import sbtbiswas.AidenOnTheGo.models.AidenGitFileStatus

/** Indentation and guide-line geometry for rows in the workspace file tree. */
internal object AidenFileTreeLayout {
    const val MAX_DEPTH = 12

    /** Nesting depth of [displayPath]: root entries are 0, capped at [MAX_DEPTH]. */
    fun depth(displayPath: String): Int = displayPath.count { it == '/' }.coerceIn(0, MAX_DEPTH)

    /** Leading inset of a row at [depth], one [step] per ancestor level. */
    fun indent(depth: Int, step: Float): Float = depth.coerceIn(0, MAX_DEPTH) * step

    /** Horizontal centers of one guide line per ancestor level, inside the row's indent. */
    fun guideCenters(depth: Int, step: Float): List<Float> =
        List(depth.coerceIn(0, MAX_DEPTH)) { level -> level * step + step / 2f }

    /** Folder disclosure chevron angle: pointing right when collapsed, down when expanded. */
    fun chevronRotation(expanded: Boolean): Float = if (expanded) 90f else 0f
}

internal data class AidenFolderCrumb(val label: String, val location: String?, val isCurrent: Boolean)

/** Breadcrumb trail for the desktop folder browser, always led by the Roots crumb. */
internal fun aidenFolderCrumbs(breadcrumbs: List<AidenBrowserBreadcrumb>): List<AidenFolderCrumb> =
    listOf(AidenFolderCrumb("Roots", null, breadcrumbs.isEmpty())) +
        breadcrumbs.mapIndexed { index, crumb ->
            AidenFolderCrumb(crumb.label, crumb.location, index == breadcrumbs.lastIndex)
        }

internal enum class AidenDiffLineKind { ADDITION, DELETION, HUNK, HEADER, CONTEXT }

/** Classifies one unified-diff line. File headers (`--- a/`, `+++ b/`) are not edits. */
internal fun aidenDiffLineKind(line: String): AidenDiffLineKind = when {
    line.startsWith("--- a/") || line.startsWith("+++ b/") ||
        line == "--- /dev/null" || line == "+++ /dev/null" -> AidenDiffLineKind.HEADER
    line.startsWith("@@") -> AidenDiffLineKind.HUNK
    line.startsWith("+") -> AidenDiffLineKind.ADDITION
    line.startsWith("-") -> AidenDiffLineKind.DELETION
    line.isEmpty() || line.startsWith(" ") -> AidenDiffLineKind.CONTEXT
    else -> AidenDiffLineKind.HEADER
}

internal data class AidenDiffColors(
    val additionFill: Color,
    val additionInk: Color,
    val deletionFill: Color,
    val deletionInk: Color,
    val hunkInk: Color,
    val headerInk: Color,
    val contextInk: Color
) {
    fun fill(kind: AidenDiffLineKind): Color = when (kind) {
        AidenDiffLineKind.ADDITION -> additionFill
        AidenDiffLineKind.DELETION -> deletionFill
        else -> Color.Transparent
    }

    fun ink(kind: AidenDiffLineKind): Color = when (kind) {
        AidenDiffLineKind.ADDITION -> additionInk
        AidenDiffLineKind.DELETION -> deletionInk
        AidenDiffLineKind.HUNK -> hunkInk
        AidenDiffLineKind.HEADER -> headerInk
        AidenDiffLineKind.CONTEXT -> contextInk
    }
}

/**
 * Theme-aware diff colors: soft success/danger fills with inks pulled toward the
 * foreground so added and removed lines stay readable on light and dark surfaces.
 */
internal fun aidenDiffColors(palette: AidenPalette): AidenDiffColors {
    val dark = palette.canvas.luminance() < 0.5f
    val fillAlpha = if (dark) 0.18f else 0.12f
    val inkMix = if (dark) 0.45f else 0.62f
    return AidenDiffColors(
        additionFill = palette.success.copy(alpha = fillAlpha),
        additionInk = lerp(palette.success, palette.foreground, inkMix),
        deletionFill = palette.danger.copy(alpha = fillAlpha),
        deletionInk = lerp(palette.danger, palette.foreground, inkMix),
        hunkInk = palette.accent,
        headerInk = palette.secondary,
        contextInk = palette.foreground
    )
}

/** Semantic palette tint for a changed file's status badge. */
internal fun aidenGitStatusTint(status: AidenGitFileStatus, palette: AidenPalette): Color = when (status) {
    AidenGitFileStatus.ADDED, AidenGitFileStatus.UNTRACKED -> palette.success
    AidenGitFileStatus.DELETED, AidenGitFileStatus.CONFLICTED -> palette.danger
    AidenGitFileStatus.MODIFIED, AidenGitFileStatus.RENAMED -> palette.warning
}
