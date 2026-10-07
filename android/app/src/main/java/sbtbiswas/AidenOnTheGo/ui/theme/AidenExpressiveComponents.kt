package sbtbiswas.AidenOnTheGo.ui.theme

import sbtbiswas.AidenOnTheGo.config.AidenPalette

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Shared Material 3 Expressive geometry for connected groups and squircle actions. */
object AidenShape {
    /** Outer corner radius of a connected card group. */
    val GroupOuter = 20.dp

    /** Inner seam radius between adjacent cards in a connected group. */
    val GroupInner = 6.dp

    /** Gap between adjacent cards in a connected group. */
    val GroupGap = 2.dp

    /** Outer radius of a connected split or segmented action. */
    val SplitOuter = 16.dp

    /** Inner seam radius of a connected split or segmented action. */
    val SplitInner = 4.dp

    /** Shared squircle radius for buttons and compact actions. */
    val Button = RoundedCornerShape(12.dp)

    /** Dialog container radius. */
    val Dialog = RoundedCornerShape(24.dp)

    /** Snackbar and floating toast radius. */
    val Snackbar = RoundedCornerShape(16.dp)
}

enum class AidenGroupOrientation { VERTICAL, HORIZONTAL }

/**
 * Corner shape for item [index] of [count] in a connected group: the first and last items
 * take the [outer] radius on the group's outside edges, and every seam between items
 * takes the [inner] radius. A single item is fully rounded with [outer].
 */
fun aidenGroupItemShape(
    index: Int,
    count: Int,
    outer: Dp = AidenShape.GroupOuter,
    inner: Dp = AidenShape.GroupInner,
    orientation: AidenGroupOrientation = AidenGroupOrientation.VERTICAL
): RoundedCornerShape {
    require(count > 0) { "count must be positive" }
    require(index in 0 until count) { "index $index out of 0 until $count" }
    val leading = if (index == 0) outer else inner
    val trailing = if (index == count - 1) outer else inner
    return when (orientation) {
        AidenGroupOrientation.VERTICAL -> RoundedCornerShape(
            topStart = leading,
            topEnd = leading,
            bottomEnd = trailing,
            bottomStart = trailing
        )
        AidenGroupOrientation.HORIZONTAL -> RoundedCornerShape(
            topStart = leading,
            bottomStart = leading,
            topEnd = trailing,
            bottomEnd = trailing
        )
    }
}

/** Vertical stack that spaces connected group cards by the shared seam gap. */
@Composable
fun AidenConnectedColumn(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap),
        content = content
    )
}

/**
 * One card in a connected group. Selection is communicated with a tonal fill only (never
 * a decorative border); the fill animates unless motion is reduced. Supply [onClick] for
 * tappable rows and [role] for their accessibility role.
 */
@Composable
fun AidenGroupCard(
    index: Int,
    count: Int,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    role: Role? = Role.Button,
    enabled: Boolean = true,
    containerColor: Color = AidenTheme.palette.raised,
    selectedContainerColor: Color = AidenTheme.palette.accent.copy(alpha = 0.12f),
    orientation: AidenGroupOrientation = AidenGroupOrientation.VERTICAL,
    contentPadding: PaddingValues = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
    verticalAlignment: Alignment.Vertical = Alignment.CenterVertically,
    horizontalArrangement: Arrangement.Horizontal = Arrangement.spacedBy(12.dp),
    content: @Composable RowScope.() -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val fill by animateColorAsState(
        targetValue = if (selected) selectedContainerColor else containerColor,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "group_card_fill"
    )
    val shape = aidenGroupItemShape(index, count, orientation = orientation)
    val row: @Composable () -> Unit = {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AidenUi.MinimumTouchTarget)
                .padding(contentPadding),
            verticalAlignment = verticalAlignment,
            horizontalArrangement = horizontalArrangement,
            content = content
        )
    }
    if (onClick != null) {
        val interaction = remember { MutableInteractionSource() }
        Surface(
            onClick = onClick,
            enabled = enabled,
            shape = shape,
            color = fill,
            interactionSource = interaction,
            modifier = modifier
                .fillMaxWidth()
                .tactilePress(interaction, targetScale = 0.985f)
                .semantics { if (role != null) this.role = role }
        ) { row() }
    } else {
        Surface(
            shape = shape,
            color = fill,
            modifier = modifier.fillMaxWidth()
        ) { row() }
    }
}

/**
 * Connected segmented selector (M3 Expressive button group). Each segment is a radio
 * choice with a tonal selected fill; segments share an outer pill and narrow inner seams.
 */
@Composable
fun <T> AidenSegmentedPillRow(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
    icon: ((T) -> ImageVector?)? = null,
    enabled: Boolean = true,
    role: Role = Role.RadioButton,
    segmentContentDescription: ((T) -> String)? = null
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        options.forEachIndexed { index, option ->
            val isSelected = option == selected
            val fill by animateColorAsState(
                targetValue = if (isSelected) palette.accent.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHigh,
                animationSpec = AidenMotion.nonSpatial(reduceMotion),
                label = "segment_fill"
            )
            val ink by animateColorAsState(
                targetValue = if (isSelected) palette.accent else palette.foreground,
                animationSpec = AidenMotion.nonSpatial(reduceMotion),
                label = "segment_ink"
            )
            val interaction = remember { MutableInteractionSource() }
            Surface(
                shape = aidenGroupItemShape(
                    index,
                    options.size,
                    outer = AidenShape.GroupOuter,
                    inner = AidenShape.GroupInner,
                    orientation = AidenGroupOrientation.HORIZONTAL
                ),
                color = fill,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .heightIn(min = 44.dp)
                    .tactilePress(interaction)
                    .selectable(
                        selected = isSelected,
                        enabled = enabled,
                        role = role,
                        interactionSource = interaction,
                        indication = androidx.compose.material3.ripple(),
                        onClick = { if (!isSelected) onSelect(option) }
                    )
                    .then(
                        if (segmentContentDescription != null) {
                            Modifier.semantics { contentDescription = segmentContentDescription(option) }
                        } else {
                            Modifier
                        }
                    )
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    val vector = icon?.invoke(option)
                    if (vector != null) {
                        Icon(vector, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        text = label(option),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                        color = ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}

/**
 * M3 Expressive split button: a primary action segment and a trailing menu segment joined
 * by a narrow seam. The chevron turns when the menu is open; [menuContent] renders inside
 * the anchored dropdown.
 */
@Composable
fun AidenSplitButton(
    label: String,
    onClick: () -> Unit,
    menuExpanded: Boolean,
    onMenuExpandedChange: (Boolean) -> Unit,
    menuContentDescription: String,
    modifier: Modifier = Modifier,
    leadingIcon: ImageVector? = null,
    enabled: Boolean = true,
    containerColor: Color = AidenTheme.palette.accent,
    contentColor: Color = AidenTheme.palette.onAccent,
    height: Dp = 40.dp,
    menuContent: @Composable ColumnScope.() -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val chevronRotation by animateFloatAsState(
        targetValue = if (menuExpanded) 180f else 0f,
        animationSpec = AidenMotion.spatial(reduceMotion),
        label = "split_chevron"
    )
    val fill = if (enabled) containerColor else containerColor.copy(alpha = containerColor.alpha * 0.38f)
    val primaryInteraction = remember { MutableInteractionSource() }
    val menuInteraction = remember { MutableInteractionSource() }
    Row(
        modifier = modifier.height(height),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        Surface(
            onClick = onClick,
            enabled = enabled,
            shape = aidenGroupItemShape(0, 2, AidenShape.SplitOuter, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
            color = fill,
            contentColor = contentColor,
            interactionSource = primaryInteraction,
            modifier = Modifier
                .fillMaxHeight()
                .tactilePress(primaryInteraction)
                .semantics { role = Role.Button }
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                if (leadingIcon != null) {
                    Icon(leadingIcon, contentDescription = null, modifier = Modifier.size(16.dp))
                }
                Text(label, style = MaterialTheme.typography.labelLarge, color = contentColor, maxLines = 1)
            }
        }
        Box {
            Surface(
                onClick = { onMenuExpandedChange(!menuExpanded) },
                enabled = enabled,
                shape = aidenGroupItemShape(1, 2, AidenShape.SplitOuter, AidenShape.SplitInner, AidenGroupOrientation.HORIZONTAL),
                color = fill,
                contentColor = contentColor,
                interactionSource = menuInteraction,
                modifier = Modifier
                    .fillMaxHeight()
                    .width(maxOf(height, 36.dp))
                    .tactilePress(menuInteraction)
                    .semantics {
                        role = Role.Button
                        contentDescription = menuContentDescription
                    }
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Default.KeyboardArrowDown,
                        contentDescription = null,
                        modifier = Modifier
                            .size(18.dp)
                            .graphicsLayer { rotationZ = chevronRotation }
                    )
                }
            }
            DropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { onMenuExpandedChange(false) },
                shape = AidenShape.Snackbar,
                containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                content = menuContent
            )
        }
    }
}

/** Filled squircle primary action. Use [destructive] for irreversible actions. */
@Composable
fun AidenPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    destructive: Boolean = false,
    leadingIcon: ImageVector? = null
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = AidenShape.Button,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (destructive) palette.danger else palette.accent,
            contentColor = if (destructive) AidenPalette.readableOn(palette.danger) else palette.onAccent
        ),
        modifier = modifier
            .heightIn(min = 40.dp)
            .tactilePress(interaction)
    ) {
        if (leadingIcon != null) {
            Icon(leadingIcon, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * Quiet tonal squircle action for secondary choices such as Cancel. With [destructive]
 * it becomes a soft semantic danger fill with danger ink.
 */
@Composable
fun AidenTonalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    destructive: Boolean = false,
    leadingIcon: ImageVector? = null,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val ink = if (destructive) palette.danger else palette.foreground
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = AidenShape.Button,
        interactionSource = interaction,
        contentPadding = contentPadding,
        elevation = null,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (destructive) palette.danger.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = ink
        ),
        modifier = modifier
            .heightIn(min = 40.dp)
            .tactilePress(interaction)
    ) {
        if (leadingIcon != null) {
            Icon(leadingIcon, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, color = ink)
    }
}

/** Primary action slot for an `AlertDialog`. */
@Composable
fun AidenDialogConfirmButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    destructive: Boolean = false
) = AidenPrimaryButton(text = text, onClick = onClick, enabled = enabled, destructive = destructive)

/** Dismiss action slot for an `AlertDialog`. */
@Composable
fun AidenDialogDismissButton(
    text: String = "Cancel",
    onClick: () -> Unit
) = AidenTonalButton(text = text, onClick = onClick)

/** Tonal squircle snackbar that floats in Aiden's surface language. */
@Composable
fun AidenSnackbar(data: SnackbarData) {
    val palette = AidenTheme.palette
    Snackbar(
        modifier = Modifier.padding(horizontal = 16.dp),
        shape = AidenShape.Snackbar,
        containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        contentColor = palette.foreground,
        actionContentColor = palette.accent,
        dismissActionContentColor = palette.secondary,
        action = data.visuals.actionLabel?.let { label ->
            {
                TextButton(onClick = { data.performAction() }, shape = AidenShape.Button) {
                    Text(label, color = palette.accent, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    ) {
        Text(data.visuals.message, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
    }
}
