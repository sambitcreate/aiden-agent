package sbtbiswas.AidenOnTheGo.features.shared

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import sbtbiswas.AidenOnTheGo.ui.theme.rememberAidenFullSheetState

const val AidenModelPickerSearchTag = "aiden.modelPicker.search"
const val AidenModelPickerListTag = "aiden.modelPicker.list"
const val AidenModelPickerSummaryTag = "aiden.modelPicker.summary"
internal const val AidenStillBottomSheetTag = "aiden.sheet.still"

/**
 * The one model picker used by the composer, the Bot editor and Bot access.
 *
 * A summary of the current choice and an optional [header] (the composer's thinking
 * selector) stay pinned above a search field; below them a lazy list shows the Default
 * state, recent picks and every provider as a collapsible group under a sticky header.
 * Rows are single radio choices: the whole row is the target, and the chosen row gets a
 * tonal fill and a check. The same model under two providers stays two rows.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AidenModelPicker(
    providers: List<AidenModelPickerProvider>,
    selection: AidenModelRoute?,
    onSelect: (AidenModelPickerEntry) -> Unit,
    modifier: Modifier = Modifier,
    defaultRoute: AidenModelRoute? = null,
    allowsDefault: Boolean = false,
    recentRoutes: List<AidenModelRoute> = emptyList(),
    containerColor: Color = MaterialTheme.colorScheme.surfaceContainerLow,
    onConfirmCurrent: () -> Unit = {},
    header: @Composable ColumnScope.() -> Unit = {}
) {
    var query by rememberSaveable { mutableStateOf("") }
    var collapsed by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val content = remember(providers, selection, defaultRoute, recentRoutes, query, collapsed, allowsDefault) {
        aidenModelPickerContent(
            providers = providers,
            selection = selection,
            defaultRoute = defaultRoute,
            recentRoutes = recentRoutes,
            query = query,
            collapsedProviderIds = collapsed.toSet(),
            allowsDefault = allowsDefault
        )
    }
    val items = remember(content) { aidenModelPickerItems(content) }
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = aidenModelPickerInitialIndex(items))

    Column(modifier = modifier.fillMaxWidth()) {
        AidenModelPickerSummary(
            content = content,
            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter)
        )
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(horizontal = AidenUi.ScreenGutter),
            content = header
        )
        AidenModelPickerSearchField(
            query = query,
            onQueryChange = { query = it },
            modifier = Modifier
                .padding(horizontal = AidenUi.ScreenGutter)
                .padding(top = 16.dp, bottom = 8.dp)
        )
        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(bottom = 24.dp),
            modifier = Modifier
                .weight(1f, fill = false)
                .fillMaxWidth()
                .selectableGroup()
                .testTag(AidenModelPickerListTag)
        ) {
            items.forEach { item ->
                when (item) {
                    AidenModelPickerItem.Default -> item(key = item.key, contentType = "default") {
                        AidenModelPickerDefaultRow(content.defaultEntry, onClick = onConfirmCurrent)
                    }
                    AidenModelPickerItem.RecentHeader -> stickyHeader(key = item.key, contentType = "header") {
                        AidenModelPickerPlainHeader(stringResource(R.string.model_picker_recent), containerColor)
                    }
                    is AidenModelPickerItem.Recent -> item(key = item.key, contentType = "row") {
                        AidenModelPickerRowItem(item.row, showsProvider = true, onClick = { onSelect(item.row.entry) }, onConfirm = onConfirmCurrent)
                    }
                    is AidenModelPickerItem.Header -> stickyHeader(key = item.key, contentType = "header") {
                        AidenModelPickerProviderHeader(
                            section = item.section,
                            collapsible = !content.isSearching,
                            containerColor = containerColor,
                            onToggle = {
                                val id = item.section.provider.id
                                collapsed = if (id in collapsed) collapsed - id else collapsed + id
                            }
                        )
                    }
                    is AidenModelPickerItem.Model -> item(key = item.key, contentType = "row") {
                        AidenModelPickerRowItem(item.row, showsProvider = false, onClick = { onSelect(item.row.entry) }, onConfirm = onConfirmCurrent)
                    }
                    AidenModelPickerItem.NoResults -> item(key = item.key, contentType = "empty") {
                        AidenModelPickerNoResults(query.trim())
                    }
                }
            }
        }
    }
}

/**
 * Bottom sheet around [AidenModelPicker]. It opens fully expanded and tall so the list
 * scrolls inside it; picking a row reports the choice and closes the sheet. Reduced
 * motion presents the same content in a still sheet with no slide or predictive back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenModelPickerSheet(
    title: String,
    providers: List<AidenModelPickerProvider>,
    selection: AidenModelRoute?,
    onSelect: (AidenModelPickerEntry) -> Unit,
    onDismiss: () -> Unit,
    defaultRoute: AidenModelRoute? = null,
    allowsDefault: Boolean = false,
    recentRoutes: List<AidenModelRoute> = emptyList(),
    header: @Composable ColumnScope.() -> Unit = {}
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val sheetState = rememberAidenFullSheetState()
    val scope = rememberCoroutineScope()

    fun close() {
        if (reduceMotion) {
            onDismiss()
        } else {
            scope.launch { sheetState.hide() }.invokeOnCompletion {
                if (!sheetState.isVisible) onDismiss()
            }
        }
    }

    val body: @Composable () -> Unit = {
        Column(modifier = Modifier.fillMaxWidth().fillMaxHeight()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = AidenUi.ScreenGutter, end = 8.dp, top = 8.dp, bottom = 8.dp)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    modifier = Modifier
                        .weight(1f)
                        .semantics { heading() }
                )
                IconButton(onClick = ::close) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.model_picker_close))
                }
            }
            AidenModelPicker(
                providers = providers,
                selection = selection,
                onSelect = { entry ->
                    onSelect(entry)
                    close()
                },
                defaultRoute = defaultRoute,
                allowsDefault = allowsDefault,
                recentRoutes = recentRoutes,
                containerColor = palette.raised,
                onConfirmCurrent = ::close,
                header = header,
                modifier = Modifier.weight(1f)
            )
        }
    }

    if (reduceMotion) {
        AidenStillBottomSheet(onDismiss = onDismiss, containerColor = palette.raised, showsDragHandle = false) { body() }
    } else {
        // The list owns vertical gestures, so the sheet does not drag; the close
        // button, the scrim and system back dismiss it.
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
            containerColor = palette.raised,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            body()
        }
    }
}

/**
 * Settings-style row naming the current model; tapping it opens [AidenModelPickerSheet].
 * Used where a screen already scrolls and an inline list would nest scrolling.
 */
@Composable
fun AidenModelPickerField(
    title: String,
    providers: List<AidenModelPickerProvider>,
    selection: AidenModelRoute?,
    onSelect: (AidenModelPickerEntry) -> Unit,
    modifier: Modifier = Modifier,
    containerColor: Color = MaterialTheme.colorScheme.surfaceContainerHigh
) {
    var showsSheet by rememberSaveable { mutableStateOf(false) }
    val current = remember(providers, selection) {
        aidenModelPickerContent(providers, selection).current
    }
    val changeLabel = stringResource(R.string.model_picker_change)
    ListItem(
        headlineContent = {
            Text(
                text = current?.model?.label ?: stringResource(R.string.model_picker_none),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        },
        supportingContent = if (current != null) {
            { Text(aidenModelPickerSupportingText(current, showsProvider = true), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        } else null,
        leadingContent = if (current != null) {
            {
                AidenProviderIcon(
                    providerId = current.provider.id,
                    providerLabel = current.provider.label,
                    modelId = current.model.id,
                    artwork = current.provider.artwork,
                    size = 32.dp,
                    modifier = Modifier.clearAndSetSemantics {}
                )
            }
        } else null,
        trailingContent = { Icon(Icons.Default.UnfoldMore, contentDescription = null) },
        colors = ListItemDefaults.colors(containerColor = containerColor),
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .clickable(role = Role.Button, onClickLabel = changeLabel) { showsSheet = true }
    )
    if (showsSheet) {
        AidenModelPickerSheet(
            title = title,
            providers = providers,
            selection = selection,
            onSelect = onSelect,
            onDismiss = { showsSheet = false }
        )
    }
}

/**
 * Bottom sheet without motion: appears and dismisses instantly, and system back or a scrim
 * tap closes it without the predictive-back shrink. Used when motion is reduced.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AidenStillBottomSheet(
    onDismiss: () -> Unit,
    containerColor: Color,
    showsDragHandle: Boolean = true,
    content: @Composable () -> Unit
) {
    val maxSheetHeight = with(LocalDensity.current) { (LocalWindowInfo.current.containerSize.height * 0.9f).toDp() }
    Popup(
        alignment = Alignment.BottomCenter,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(BottomSheetDefaults.ScrimColor)
                .clickable(interactionSource = null, indication = null, onClickLabel = "Close sheet", onClick = onDismiss)
                .testTag(AidenStillBottomSheetTag),
            contentAlignment = Alignment.BottomCenter
        ) {
            Surface(
                shape = BottomSheetDefaults.ExpandedShape,
                color = containerColor,
                modifier = Modifier
                    .widthIn(max = BottomSheetDefaults.SheetMaxWidth)
                    .fillMaxWidth()
                    .heightIn(max = maxSheetHeight)
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                ) {
                    if (showsDragHandle) BottomSheetDefaults.DragHandle()
                    content()
                }
            }
        }
    }
}

@Composable
private fun aidenModelCapabilityLabel(capability: AidenModelCapability): String = when (capability) {
    AidenModelCapability.VISION -> stringResource(R.string.model_picker_capability_vision)
    AidenModelCapability.REASONING -> stringResource(R.string.model_picker_capability_reasoning)
}

/** "Vision · Reasoning", led by the provider name when the row sits outside its group. */
@Composable
private fun aidenModelPickerSupportingText(entry: AidenModelPickerEntry, showsProvider: Boolean): String {
    val parts = buildList {
        if (showsProvider) add(entry.provider.label)
        if (!entry.model.available) add(stringResource(R.string.model_picker_unavailable))
        entry.model.capabilities.forEach { add(aidenModelCapabilityLabel(it)) }
    }
    return parts.joinToString(" · ")
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AidenModelPickerSummary(content: AidenModelPickerContent, modifier: Modifier = Modifier) {
    val entry = content.current ?: content.defaultEntry?.takeIf { content.showsDefault }
    val isMacDefault = content.currentIsMacDefault || (content.showsDefault && entry != null)
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.large,
        modifier = modifier.fillMaxWidth()
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .testTag(AidenModelPickerSummaryTag)
                .semantics(mergeDescendants = true) {}
                .padding(16.dp)
        ) {
            if (entry != null) {
                AidenProviderIcon(
                    providerId = entry.provider.id,
                    providerLabel = entry.provider.label,
                    modelId = entry.model.id,
                    artwork = entry.provider.artwork,
                    size = 40.dp,
                    modifier = Modifier.clearAndSetSemantics {}
                )
            } else {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(40.dp)
                        .clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                ) {
                    Icon(Icons.Default.Laptop, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.width(16.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
                Text(
                    text = entry?.model?.label ?: stringResource(R.string.model_picker_default),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = entry?.provider?.label ?: stringResource(R.string.model_picker_default_unknown),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                val chips = buildList {
                    if (isMacDefault) add(stringResource(R.string.model_picker_mac_default))
                    entry?.model?.capabilities?.forEach { add(aidenModelCapabilityLabel(it)) }
                }
                if (chips.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(top = 6.dp)
                    ) {
                        chips.forEach { AidenModelPickerChip(it) }
                    }
                }
            }
        }
    }
}

/** Soft tonal label; no border, per the badge rule. */
@Composable
private fun AidenModelPickerChip(text: String) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )
    }
}

@Composable
private fun AidenModelPickerSearchField(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val focusManager = LocalFocusManager.current
    TextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        placeholder = { Text(stringResource(R.string.model_picker_search)) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = if (query.isEmpty()) null else {
            {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.model_picker_search_clear))
                }
            }
        },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
        shape = MaterialTheme.shapes.extraLarge,
        colors = aidenTextFieldColors(),
        modifier = modifier
            .fillMaxWidth()
            .testTag(AidenModelPickerSearchTag)
    )
}

@Composable
private fun AidenModelPickerRowItem(
    row: AidenModelPickerRow,
    showsProvider: Boolean,
    onClick: () -> Unit,
    onConfirm: () -> Unit
) {
    val entry = row.entry
    val supporting = aidenModelPickerSupportingText(entry, showsProvider)
    val colors = MaterialTheme.colorScheme
    ListItem(
        headlineContent = {
            Text(
                text = entry.model.label,
                fontWeight = if (row.isSelected) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        },
        supportingContent = if (supporting.isNotEmpty()) {
            { Text(supporting, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        } else null,
        leadingContent = if (showsProvider) {
            {
                AidenProviderIcon(
                    providerId = entry.provider.id,
                    providerLabel = entry.provider.label,
                    modelId = entry.model.id,
                    artwork = entry.provider.artwork,
                    size = 24.dp,
                    modifier = Modifier.clearAndSetSemantics {}
                )
            }
        } else null,
        trailingContent = if (row.isSelected) {
            { Icon(Icons.Default.Check, contentDescription = null) }
        } else null,
        colors = if (row.isSelected) {
            ListItemDefaults.colors(
                containerColor = colors.secondaryContainer,
                headlineColor = colors.onSecondaryContainer,
                supportingColor = colors.onSecondaryContainer,
                trailingIconColor = colors.onSecondaryContainer
            )
        } else {
            ListItemDefaults.colors(
                containerColor = Color.Transparent,
                headlineColor = if (entry.model.available) colors.onSurface else colors.onSurface.copy(alpha = 0.38f)
            )
        },
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 1.dp)
            .clip(MaterialTheme.shapes.large)
            .heightIn(min = 56.dp)
            .selectable(
                selected = row.isSelected,
                enabled = entry.model.available || row.isSelected,
                role = Role.RadioButton,
                // Tapping the checked row keeps the choice (and its thinking level) as is.
                onClick = { if (row.isSelected) onConfirm() else onClick() }
            )
    )
}

@Composable
private fun AidenModelPickerDefaultRow(defaultEntry: AidenModelPickerEntry?, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    ListItem(
        headlineContent = { Text(stringResource(R.string.model_picker_default), fontWeight = FontWeight.SemiBold) },
        supportingContent = {
            Text(
                text = defaultEntry?.let {
                    stringResource(R.string.model_picker_default_uses, it.model.label, it.provider.label)
                } ?: stringResource(R.string.model_picker_default_unknown),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        },
        leadingContent = { Icon(Icons.Default.Laptop, contentDescription = null) },
        trailingContent = { Icon(Icons.Default.Check, contentDescription = null) },
        colors = ListItemDefaults.colors(
            containerColor = colors.secondaryContainer,
            headlineColor = colors.onSecondaryContainer,
            supportingColor = colors.onSecondaryContainer,
            leadingIconColor = colors.onSecondaryContainer,
            trailingIconColor = colors.onSecondaryContainer
        ),
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 1.dp)
            .clip(MaterialTheme.shapes.large)
            .heightIn(min = 56.dp)
            // The Default state is the current choice; tapping it only confirms it.
            .selectable(selected = true, role = Role.RadioButton, onClick = onClick)
    )
}

@Composable
private fun AidenModelPickerPlainHeader(text: String, containerColor: Color) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .background(containerColor)
            .heightIn(min = 48.dp)
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 14.dp)
            .semantics { heading() }
    )
}

@Composable
private fun AidenModelPickerProviderHeader(
    section: AidenModelPickerSection,
    collapsible: Boolean,
    containerColor: Color,
    onToggle: () -> Unit
) {
    val reduceMotion = aidenReduceMotion()
    val provider = section.provider
    val expanded = !section.isCollapsed
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 0f else -90f,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "model_picker_group_chevron"
    )
    val stateText = stringResource(if (expanded) R.string.model_picker_group_expanded else R.string.model_picker_group_collapsed)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(containerColor)
            .heightIn(min = 48.dp)
            .then(
                if (collapsible) {
                    Modifier
                        .clickable(role = Role.Button, onClick = onToggle)
                        .semantics { stateDescription = stateText }
                } else Modifier
            )
            .semantics { heading() }
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 8.dp)
    ) {
        AidenProviderIcon(
            providerId = provider.id,
            providerLabel = provider.label,
            modelId = provider.models.firstOrNull()?.id,
            artwork = provider.artwork,
            size = 24.dp,
            modifier = Modifier.clearAndSetSemantics {}
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = provider.label,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = pluralStringResource(R.plurals.model_picker_group_count, section.rows.size, section.rows.size),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (collapsible) {
            Spacer(Modifier.width(8.dp))
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .size(20.dp)
                    .rotate(chevronRotation)
            )
        }
    }
}

@Composable
private fun AidenModelPickerNoResults(query: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = AidenUi.ScreenGutter, vertical = 32.dp)
    ) {
        Icon(Icons.Default.SearchOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            text = stringResource(R.string.model_picker_no_results, query),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface
        )
        Text(
            text = stringResource(R.string.model_picker_no_results_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
