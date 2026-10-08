package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScaffoldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSectionLabel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonListRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** Test tag of every Settings-style page's scrolling list. */
const val AidenSettingsListTag = "aiden_settings_list"

/** Shared metrics and surfaces for every Settings-style page. */
object AidenSettingsDefaults {
    /** Page background. Groups sit one tonal step above it so their grouping reads. */
    val screenColor: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerLow

    val groupColor: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainer

    val Gutter = 16.dp
    val GroupSpacing = 24.dp

    /** Divider inset for rows with a leading icon: list padding + icon + gap, so it lines up with the text. */
    val DividerInsetWithIcon = 56.dp

    /** Divider inset for text-only rows. */
    val DividerInset = 16.dp
}

/**
 * Full-screen Settings page: a collapsing large top app bar with a back action over a
 * lazily scrolled column of groups. Insets come from the Scaffold, so content scrolls
 * edge to edge behind the navigation bar and stays clear of the keyboard.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenSettingsScaffold(
    title: String,
    onNavigateBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    navigationIcon: ImageVector = Icons.AutoMirrored.Filled.ArrowBack,
    navigationContentDescription: String = stringResource(R.string.action_back),
    actions: @Composable RowScope.() -> Unit = {},
    listState: LazyListState = rememberLazyListState(),
    content: LazyListScope.() -> Unit
) {
    val palette = AidenTheme.palette
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val layoutDirection = LocalLayoutDirection.current
    Scaffold(
        modifier = modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        containerColor = AidenSettingsDefaults.screenColor,
        contentWindowInsets = ScaffoldDefaults.contentWindowInsets,
        topBar = {
            LargeTopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (onNavigateBack != null) {
                        IconButton(onClick = onNavigateBack) {
                            Icon(navigationIcon, contentDescription = navigationContentDescription)
                        }
                    }
                },
                actions = actions,
                scrollBehavior = scrollBehavior,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = AidenSettingsDefaults.screenColor,
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    titleContentColor = palette.foreground,
                    navigationIconContentColor = palette.foreground,
                    actionIconContentColor = palette.foreground
                )
            )
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .consumeWindowInsets(padding)
                .imePadding()
                .testTag(AidenSettingsListTag),
            contentPadding = PaddingValues(
                start = padding.calculateStartPadding(layoutDirection) + AidenSettingsDefaults.Gutter,
                end = padding.calculateEndPadding(layoutDirection) + AidenSettingsDefaults.Gutter,
                top = padding.calculateTopPadding() + 8.dp,
                bottom = padding.calculateBottomPadding() + AidenSettingsDefaults.GroupSpacing
            ),
            verticalArrangement = Arrangement.spacedBy(AidenSettingsDefaults.GroupSpacing),
            content = content
        )
    }
}

/** Collects the rows of one [AidenSettingsGroup] so the group can draw inset dividers between them. */
class AidenSettingsGroupScope internal constructor() {
    internal val rows = mutableListOf<Pair<Dp, @Composable () -> Unit>>()

    /** Adds a row. [dividerInset] is where the divider above the next row starts. */
    fun row(dividerInset: Dp = AidenSettingsDefaults.DividerInsetWithIcon, content: @Composable () -> Unit) {
        rows += dividerInset to content
    }
}

/**
 * One titled settings group: a single group-title style, a tonal card in the Material large
 * shape, inset `outlineVariant` dividers between rows, and optional footer and error copy.
 * Set [selectableGroup] when the rows are one radio choice.
 */
@Composable
fun AidenSettingsGroup(
    title: String?,
    modifier: Modifier = Modifier,
    footer: String? = null,
    error: String? = null,
    selectableGroup: Boolean = false,
    rows: AidenSettingsGroupScope.() -> Unit
) {
    val palette = AidenTheme.palette
    val scope = AidenSettingsGroupScope().apply(rows)
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title != null) {
            AidenSectionLabel(
                text = title,
                modifier = Modifier
                    .padding(horizontal = AidenSettingsDefaults.Gutter)
                    .semantics { heading() }
            )
        }
        if (scope.rows.isNotEmpty()) {
            Surface(
                shape = MaterialTheme.shapes.large,
                color = AidenSettingsDefaults.groupColor,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(if (selectableGroup) Modifier.selectableGroup() else Modifier) {
                    scope.rows.forEachIndexed { index, (_, content) ->
                        if (index > 0) {
                            HorizontalDivider(
                                color = MaterialTheme.colorScheme.outlineVariant,
                                modifier = Modifier.padding(start = scope.rows[index - 1].first)
                            )
                        }
                        content()
                    }
                }
            }
        }
        if (error != null) {
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = palette.danger,
                modifier = Modifier.padding(horizontal = AidenSettingsDefaults.Gutter)
            )
        }
        if (footer != null) {
            Text(
                footer,
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary,
                modifier = Modifier.padding(horizontal = AidenSettingsDefaults.Gutter)
            )
        }
    }
}

/** Supporting line that is either copy or, on a first load, a short placeholder bar. */
private fun aidenSettingsSupporting(text: String?, loading: Boolean): (@Composable () -> Unit)? = when {
    loading -> { { AidenSkeletonBlock(width = 120.dp, height = 12.dp) } }
    text != null -> { { Text(text) } }
    else -> null
}

@Composable
internal fun AidenSettingsListItem(
    headline: String,
    modifier: Modifier,
    supporting: (@Composable () -> Unit)?,
    leading: (@Composable () -> Unit)?,
    trailing: (@Composable () -> Unit)?,
    enabled: Boolean = true
) {
    val palette = AidenTheme.palette
    val disabled = palette.foreground.copy(alpha = 0.38f)
    ListItem(
        headlineContent = { Text(headline, style = MaterialTheme.typography.bodyLarge) },
        supportingContent = supporting,
        leadingContent = leading,
        trailingContent = trailing,
        colors = ListItemDefaults.colors(
            containerColor = Color.Transparent,
            headlineColor = if (enabled) palette.foreground else disabled,
            supportingColor = if (enabled) palette.secondary else disabled,
            leadingIconColor = if (enabled) palette.secondary else disabled,
            trailingIconColor = palette.secondary
        ),
        modifier = modifier.heightIn(min = 56.dp)
    )
}

internal fun leadingIcon(icon: ImageVector?): (@Composable () -> Unit)? =
    icon?.let { { Icon(it, contentDescription = null) } }

/** A row that opens another page. The whole row is the target; a chevron marks the push. */
@Composable
fun AidenSettingsNavigationRow(
    headline: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    supportingLoading: Boolean = false,
    leadingIcon: ImageVector? = null,
    value: String? = null
) {
    val loadingLabel = stringResource(R.string.settings_loading)
    AidenSettingsListItem(
        headline = headline,
        modifier = modifier
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { if (supportingLoading) stateDescription = loadingLabel },
        supporting = aidenSettingsSupporting(supporting, supportingLoading),
        leading = leadingIcon(leadingIcon),
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (value != null) Text(value, style = MaterialTheme.typography.bodyMedium, color = AidenTheme.palette.secondary)
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
            }
        }
    )
}

/**
 * A switch the whole row toggles, announced as one Switch with the headline as its label.
 * A null [checked] value is unknown: the row shows a placeholder instead of a fake state
 * and cannot be toggled.
 */
@Composable
fun AidenSettingsSwitchRow(
    headline: String,
    checked: Boolean?,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    leadingIcon: ImageVector? = null,
    enabled: Boolean = true
) {
    val loadingLabel = stringResource(R.string.settings_loading)
    val rowModifier = if (checked == null) {
        modifier.semantics(mergeDescendants = true) { stateDescription = loadingLabel }
    } else {
        modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
    }
    AidenSettingsListItem(
        headline = headline,
        modifier = rowModifier,
        supporting = supporting?.let { { Text(it) } },
        leading = leadingIcon(leadingIcon),
        enabled = enabled || checked == null,
        trailing = {
            if (checked == null) {
                AidenSkeletonBlock(width = 52.dp, height = 32.dp, shape = CircleShape)
            } else {
                Switch(checked = checked, onCheckedChange = null, enabled = enabled)
            }
        }
    )
}

/** A label with a trailing value. Pass [onClick] when the row opens something. */
@Composable
fun AidenSettingsValueRow(
    headline: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    supporting: String? = null,
    supportingLoading: Boolean = false,
    leadingIcon: ImageVector? = null,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null
) {
    val loadingLabel = stringResource(R.string.settings_loading)
    AidenSettingsListItem(
        headline = headline,
        modifier = modifier
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .semantics(mergeDescendants = onClick == null) { if (supportingLoading) stateDescription = loadingLabel },
        supporting = aidenSettingsSupporting(supporting, supportingLoading),
        leading = leadingIcon(leadingIcon),
        trailing = trailing ?: value?.let { { Text(it, style = MaterialTheme.typography.bodyMedium) } }
    )
}

/**
 * One choice of a radio group. The whole row selects; the radio control carries the state
 * and the row has no border or outline, only the list's pressed and focus states.
 */
@Composable
fun AidenSettingsRadioRow(
    headline: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    supporting: String? = null
) {
    val palette = AidenTheme.palette
    AidenSettingsListItem(
        headline = headline,
        modifier = modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
        supporting = supporting?.let { { Text(it) } },
        leading = {
            RadioButton(
                selected = selected,
                onClick = null,
                colors = RadioButtonDefaults.colors(selectedColor = palette.accent, unselectedColor = palette.secondary)
            )
        },
        trailing = null
    )
}

/** First-load placeholder rows for a group whose content has never been fetched. */
@Composable
fun AidenSettingsSkeletonRow(leading: Boolean = true, supporting: Boolean = true) {
    AidenSkeletonListRow(leading = leading, supporting = supporting)
}

/** A quiet explanatory row inside a group, for empty and unavailable states. */
@Composable
fun AidenSettingsMessageRow(text: String, modifier: Modifier = Modifier, isError: Boolean = false) {
    val palette = AidenTheme.palette
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = if (isError) palette.danger else palette.secondary,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 16.dp)
    )
}
