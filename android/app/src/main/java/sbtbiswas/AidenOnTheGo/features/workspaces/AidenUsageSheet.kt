package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import java.text.NumberFormat
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Currency
import java.util.Locale
import kotlin.math.sqrt
import sbtbiswas.AidenOnTheGo.ui.theme.AidenButtonDefaults

data class AidenUsageHeatmapDay(val date: String, val tokens: Int)

fun aidenUsageRatio(value: Int, total: Int): Double =
    if (total <= 0) 0.0 else (value.toDouble() / total.toDouble()).coerceIn(0.0, 1.0)

fun aidenUsageHeatmapDays(summary: AidenUsageSummary): List<AidenUsageHeatmapDay> {
    val totalsByDate = summary.days.associate { it.date to it.tokens.total }
    return try {
        val start = LocalDate.parse(summary.startDate)
        val end = LocalDate.parse(summary.endDate)
        if (start.isAfter(end)) throw DateTimeParseException("reversed range", summary.startDate, 0)
        generateSequence(start) { day -> day.plusDays(1).takeIf { !it.isAfter(end) } }
            .take(366)
            .map { day ->
                val key = day.toString()
                AidenUsageHeatmapDay(key, totalsByDate[key] ?: 0)
            }
            .toList()
    } catch (_: DateTimeParseException) {
        summary.days.map { AidenUsageHeatmapDay(it.date, it.tokens.total) }
    }
}

fun aidenUsageDateRangeText(summary: AidenUsageSummary, locale: Locale = Locale.getDefault()): String {
    return try {
        val formatter = DateTimeFormatter.ofPattern("MMM d", locale)
        "${LocalDate.parse(summary.startDate).format(formatter)}–${LocalDate.parse(summary.endDate).format(formatter)}"
    } catch (_: DateTimeParseException) {
        "Last 30 days"
    }
}

enum class AidenUsageTokenKind(val label: String) {
    INPUT("Input"),
    OUTPUT("Output"),
    REASONING("Reasoning"),
    CACHE_READ("Cache read")
}

fun aidenUsageTokenCount(tokens: AidenUsageTokens, kind: AidenUsageTokenKind): Int = when (kind) {
    AidenUsageTokenKind.INPUT -> tokens.input
    AidenUsageTokenKind.OUTPUT -> tokens.output
    AidenUsageTokenKind.REASONING -> tokens.reasoning
    AidenUsageTokenKind.CACHE_READ -> tokens.cacheRead
}

data class AidenUsageTokenSegment(val kind: AidenUsageTokenKind, val tokens: Int, val fraction: Float)

/**
 * Segments of the proportional token bar, in legend order. Kinds with no tokens are
 * omitted, and the remaining fractions share the whole bar.
 */
fun aidenUsageTokenSegments(tokens: AidenUsageTokens): List<AidenUsageTokenSegment> {
    val counts = AidenUsageTokenKind.entries
        .map { kind -> kind to aidenUsageTokenCount(tokens, kind) }
        .filter { (_, count) -> count > 0 }
    val sum = counts.sumOf { (_, count) -> count.toLong() }
    if (sum <= 0L) return emptyList()
    return counts.map { (kind, count) ->
        AidenUsageTokenSegment(kind, count, (count.toDouble() / sum.toDouble()).toFloat())
    }
}

/** Tapping the selected day clears the inspection; tapping any other day selects it. */
fun aidenUsageToggleSelectedDay(selectedDate: String?, tappedDate: String): String? =
    if (selectedDate == tappedDate) null else tappedDate

/** Daily-totals pill text: the inspected day and its tokens, or the default range label. */
fun aidenUsageDayInspectionLabel(day: AidenUsageHeatmapDay?, locale: Locale = Locale.getDefault()): String {
    if (day == null) return "Last 30 days"
    val date = try {
        LocalDate.parse(day.date).format(DateTimeFormatter.ofPattern("MMM d", locale))
    } catch (_: DateTimeParseException) {
        day.date
    }
    val count = NumberFormat.getIntegerInstance(locale).format(day.tokens)
    return "$date · $count ${if (day.tokens == 1) "token" else "tokens"}"
}

@Composable
fun AidenUsageSheet(
    summary: AidenUsageSummary,
    providers: List<AidenProvider>,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val integer = remember { NumberFormat.getIntegerInstance() }
    val currency = remember {
        NumberFormat.getCurrencyInstance().apply { this.currency = Currency.getInstance("USD") }
    }
    val heatmap = remember(summary) { aidenUsageHeatmapDays(summary) }
    val maximumDailyTokens = remember(heatmap) { (heatmap.maxOfOrNull { it.tokens } ?: 0).coerceAtLeast(1) }
    var selectedDate by rememberSaveable(summary.startDate, summary.endDate) { mutableStateOf<String?>(null) }
    val selectedDay = heatmap.firstOrNull { it.date == selectedDate }

    LazyColumn(
        modifier = Modifier.fillMaxWidth().fillMaxHeight(.92f).navigationBarsPadding(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 36.dp),
        verticalArrangement = Arrangement.spacedBy(28.dp)
    ) {
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp)
            ) {
                Spacer(Modifier.size(48.dp))
                Text(
                    "Usage",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.foreground,
                    modifier = Modifier.weight(1f)
                )
                TextButton(contentPadding = AidenButtonDefaults.TextContentPadding, onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Done", color = palette.accent)
                }
            }
        }

        item {
            Column(
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.semantics(mergeDescendants = true) {}
            ) {
                Text("Your Activity", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = palette.foreground)
                Text(aidenUsageDateRangeText(summary), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            }
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AidenUsageOverviewRow(
                    first = AidenUsageOverviewMetric(Icons.Default.Bolt, integer.format(summary.totals.requests), "Requests"),
                    second = AidenUsageOverviewMetric(Icons.Default.CalendarMonth, integer.format(summary.totals.activeDays), "Active days")
                )
                AidenUsageOverviewRow(
                    first = AidenUsageOverviewMetric(Icons.Default.LocalFireDepartment, aidenUsageDayCount(summary.totals.currentStreak), "Current streak"),
                    second = AidenUsageOverviewMetric(Icons.Default.EmojiEvents, aidenUsageDayCount(summary.totals.longestStreak), "Longest streak")
                )
                Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 92.dp).padding(18.dp)
                            .semantics(mergeDescendants = true) {
                                contentDescription = "${integer.format(summary.totals.tokens.total)} total tokens"
                            }
                    ) {
                        Icon(Icons.Default.Hub, null, tint = palette.accent, modifier = Modifier.size(34.dp))
                        Spacer(Modifier.width(14.dp))
                        Column {
                            Text(integer.format(summary.totals.tokens.total), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = palette.foreground)
                            Text("Total tokens", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                        }
                    }
                }
            }
        }

        item {
            AidenUsageSection("Token activity") {
                Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(18.dp), modifier = Modifier.padding(18.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Daily totals", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground, modifier = Modifier.weight(1f))
                            AidenUsageInspectionPill(selectedDay)
                        }
                        AidenUsageHeatmap(
                            days = heatmap,
                            maximumTokens = maximumDailyTokens,
                            selectedDate = selectedDay?.date,
                            onSelect = { date -> selectedDate = aidenUsageToggleSelectedDay(selectedDate, date) }
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Less", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                            repeat(5) { level ->
                                Box(Modifier.size(14.dp).background(aidenUsageActivityColor(level, palette.accent, palette.sidebar), RoundedCornerShape(3.dp)))
                            }
                            Text("More", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                        }
                        HorizontalDivider(color = palette.secondary.copy(alpha = .18f))
                        AidenUsageTokenBar(summary.totals.tokens)
                        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            AidenUsageTokenKind.entries.forEach { kind ->
                                AidenUsageValueRow(
                                    kind.label,
                                    integer.format(aidenUsageTokenCount(summary.totals.tokens, kind)),
                                    aidenUsageTokenColor(kind, palette)
                                )
                            }
                        }
                    }
                }
            }
        }

        item {
            AidenUsageSection("Activity insights") {
                Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(horizontal = 18.dp)) {
                        AidenUsageInsightRow("Completed requests", NumberFormat.getPercentInstance().format(aidenUsageRatio(summary.totals.completedRequests, summary.totals.requests)))
                        AidenUsageDivider()
                        AidenUsageInsightRow("Local model share", NumberFormat.getPercentInstance().format(aidenUsageRatio(summary.totals.localRequests, summary.totals.requests)))
                        AidenUsageDivider()
                        AidenUsageInsightRow("Failed requests", integer.format(summary.totals.failedRequests))
                        AidenUsageDivider()
                        AidenUsageInsightRow("Hosted cost", summary.totals.hostedCostSummary)
                    }
                }
            }
        }

        if (summary.models.isNotEmpty()) {
            item {
                AidenUsageSection("Most used models") {
                    Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(horizontal = 18.dp)) {
                            summary.models.take(5).forEachIndexed { index, model ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 14.dp)
                                        .semantics(mergeDescendants = true) {}
                                ) {
                                    Surface(color = palette.sidebar, shape = RoundedCornerShape(10.dp), modifier = Modifier.size(34.dp)) {
                                        Box(contentAlignment = Alignment.Center) {
                                            AidenProviderIcon(
                                                providerId = model.providerId,
                                                providerLabel = model.providerLabel,
                                                modelId = model.modelId,
                                                artwork = providers.firstOrNull { it.id == model.providerId }?.artwork,
                                                size = 20.dp
                                            )
                                        }
                                    }
                                    Spacer(Modifier.width(12.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(model.modelLabel, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(if (model.local) "${model.providerLabel} · Local" else model.providerLabel, style = MaterialTheme.typography.labelSmall, color = palette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                    Spacer(Modifier.width(8.dp))
                                    Text("${integer.format(model.requests)} runs", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                }
                                if (index < minOf(summary.models.size, 5) - 1) AidenUsageDivider()
                            }
                        }
                    }
                }
            }
        }

        item {
            Row(
                verticalAlignment = Alignment.Top,
                modifier = Modifier.fillMaxWidth()
                    .background(palette.accent.copy(alpha = .08f), RoundedCornerShape(18.dp))
                    .padding(16.dp)
                    .semantics(mergeDescendants = true) {}
            ) {
                Icon(Icons.Default.Shield, null, tint = palette.accent, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(12.dp))
                Text(
                    "Privacy-safe aggregates are recorded by Aiden Agent on your paired desktop. Prompts, responses, chat IDs, workspace IDs, and file paths are not included.",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            }
        }
    }
}

private data class AidenUsageOverviewMetric(
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val value: String,
    val label: String
)

@Composable
private fun AidenUsageOverviewRow(first: AidenUsageOverviewMetric, second: AidenUsageOverviewMetric) {
    val singleColumn = androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.4f
    if (singleColumn) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AidenUsageOverviewCard(first, Modifier.fillMaxWidth())
            AidenUsageOverviewCard(second, Modifier.fillMaxWidth())
        }
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            AidenUsageOverviewCard(first, Modifier.weight(1f))
            AidenUsageOverviewCard(second, Modifier.weight(1f))
        }
    }
}

@Composable
private fun AidenUsageOverviewCard(metric: AidenUsageOverviewMetric, modifier: Modifier) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = RoundedCornerShape(24.dp), modifier = modifier) {
        Column(
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.heightIn(min = 118.dp).padding(16.dp)
                .semantics(mergeDescendants = true) { contentDescription = "${metric.value}, ${metric.label}" }
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(30.dp).background(palette.accent.copy(alpha = .12f), RoundedCornerShape(9.dp))
            ) {
                Icon(metric.icon, null, tint = palette.accent, modifier = Modifier.size(18.dp))
            }
            Column {
                Text(metric.value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = palette.foreground, maxLines = 1)
                Text(metric.label, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            }
        }
    }
}

@Composable
private fun AidenUsageSection(title: String, content: @Composable () -> Unit) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = palette.secondary, modifier = Modifier.padding(start = 4.dp))
        content()
    }
}

@Composable
private fun AidenUsageInspectionPill(selectedDay: AidenUsageHeatmapDay?) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    val inspecting = selectedDay != null
    val fill by animateColorAsState(
        targetValue = if (inspecting) palette.accent.copy(alpha = .12f) else palette.sidebar,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "UsagePillFill"
    )
    val ink by animateColorAsState(
        targetValue = if (inspecting) palette.accent else palette.secondary,
        animationSpec = AidenMotion.nonSpatial(reduceMotion),
        label = "UsagePillInk"
    )
    Surface(
        color = fill,
        shape = RoundedCornerShape(50),
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
    ) {
        AnimatedContent(
            targetState = aidenUsageDayInspectionLabel(selectedDay),
            transitionSpec = {
                fadeIn(AidenMotion.nonSpatial(reduceMotion)) togetherWith
                    fadeOut(AidenMotion.nonSpatial(reduceMotion)) using
                    SizeTransform(clip = false) { _, _ -> AidenMotion.spatial(reduceMotion) }
            },
            contentAlignment = Alignment.CenterEnd,
            label = "UsagePillLabel"
        ) { label ->
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = if (inspecting) FontWeight.SemiBold else FontWeight.Normal,
                color = ink,
                maxLines = 1,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
            )
        }
    }
}

@Composable
private fun AidenUsageHeatmap(
    days: List<AidenUsageHeatmapDay>,
    maximumTokens: Int,
    selectedDate: String?,
    onSelect: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val reduceMotion = aidenReduceMotion()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        days.chunked(10).forEach { rowDays ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                rowDays.forEach { day ->
                    val normalized = (day.tokens.toDouble() / maximumTokens.toDouble()).coerceIn(0.0, 1.0)
                    val color = if (day.tokens <= 0) palette.sidebar else palette.accent.copy(alpha = (.22 + .78 * sqrt(normalized)).toFloat())
                    val selected = day.date == selectedDate
                    val roundness by animateFloatAsState(
                        targetValue = if (selected) 1f else 0f,
                        animationSpec = AidenMotion.spatial(reduceMotion),
                        label = "UsageCellRoundness"
                    )
                    val shape = RoundedCornerShape(AidenUsageCellCorner(roundness))
                    Box(
                        Modifier.weight(1f).aspectRatio(1f)
                            .clip(shape)
                            .background(color)
                            .selectable(selected = selected, role = Role.Button, onClick = { onSelect(day.date) })
                            .semantics { contentDescription = "${day.date}, ${day.tokens} tokens" }
                    )
                }
                repeat(10 - rowDays.size) { Spacer(Modifier.weight(1f).aspectRatio(1f)) }
            }
        }
    }
}

/** Heatmap cell corner that eases from a 5.dp squircle (0) to a full circle (1). */
private data class AidenUsageCellCorner(val roundness: Float) : CornerSize {
    override fun toPx(shapeSize: Size, density: Density): Float {
        val resting = with(density) { 5.dp.toPx() }
        val circle = shapeSize.minDimension / 2f
        return resting + (circle - resting) * roundness.coerceIn(0f, 1f)
    }
}

@Composable
private fun AidenUsageTokenBar(tokens: AidenUsageTokens) {
    val palette = AidenTheme.palette
    val segments = remember(tokens) { aidenUsageTokenSegments(tokens) }
    Row(
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        modifier = Modifier
            .fillMaxWidth()
            .height(8.dp)
            .semantics { hideFromAccessibility() }
    ) {
        if (segments.isEmpty()) {
            Box(Modifier.fillMaxSize().background(palette.sidebar, RoundedCornerShape(4.dp)))
        } else {
            segments.forEach { segment ->
                Box(
                    Modifier
                        .weight(segment.fraction.coerceAtLeast(0.02f))
                        .fillMaxHeight()
                        .background(aidenUsageTokenColor(segment.kind, palette), RoundedCornerShape(4.dp))
                )
            }
        }
    }
}

private fun aidenUsageTokenColor(kind: AidenUsageTokenKind, palette: AidenPalette): Color = when (kind) {
    AidenUsageTokenKind.INPUT -> palette.accent
    AidenUsageTokenKind.OUTPUT -> palette.success
    AidenUsageTokenKind.REASONING -> palette.warning
    AidenUsageTokenKind.CACHE_READ -> palette.secondary
}

private fun aidenUsageActivityColor(level: Int, accent: Color, inactive: Color): Color =
    if (level <= 0) inactive else accent.copy(alpha = (.18 + level * .205).toFloat().coerceAtMost(1f))

private fun aidenUsageDayCount(value: Int): String = if (value == 1) "1 day" else "$value days"

@Composable
private fun AidenUsageValueRow(label: String, value: String, color: Color) {
    val palette = AidenTheme.palette
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Box(Modifier.size(8.dp).background(color, RoundedCornerShape(50)))
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, color = palette.foreground, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
    }
}

@Composable
private fun AidenUsageInsightRow(label: String, value: String) {
    val palette = AidenTheme.palette
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).semantics(mergeDescendants = true) {}
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
    }
}

@Composable
private fun AidenUsageDivider() {
    val palette = AidenTheme.palette
    HorizontalDivider(color = palette.secondary.copy(alpha = .18f))
}
