package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenApprovalMode
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleGroup
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRulePickerOption
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleRow
import sbtbiswas.AidenOnTheGo.models.AidenApprovalRuleScopeKind
import sbtbiswas.AidenOnTheGo.navigation.AidenSettingsPage
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSegmentedPillRow
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

@Composable
internal fun aidenApprovalModeLabel(mode: AidenApprovalMode): String = stringResource(
    when (mode) {
        AidenApprovalMode.ASK -> R.string.approvals_mode_ask
        AidenApprovalMode.AUTO -> R.string.approvals_mode_auto
        AidenApprovalMode.NEVER -> R.string.approvals_mode_never
    }
)

/** Allow / Ask / Block, resolved once so the segmented control can label its segments. */
@Composable
private fun aidenApprovalDecisionLabels(): Map<AidenApprovalRuleDecision, String> = mapOf(
    AidenApprovalRuleDecision.ALLOW to stringResource(R.string.approvals_decision_allow),
    AidenApprovalRuleDecision.ASK to stringResource(R.string.approvals_decision_ask),
    AidenApprovalRuleDecision.BLOCK to stringResource(R.string.approvals_decision_block)
)

/** The order the page offers the modes in, as on the Mac (`APPROVAL_MODES`). */
private val ModeOrder = listOf(AidenApprovalMode.AUTO, AidenApprovalMode.ASK, AidenApprovalMode.NEVER)

/** The root Settings row. It shows only when this phone holds `approvals:settings`. */
@Composable
internal fun AidenApprovalsRootGroup(controller: AidenApprovalSettingsController, onNavigate: (AidenSettingsPage) -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { controller.refresh() }
    AidenSettingsGroup(title = stringResource(R.string.approvals_group)) {
        row {
            AidenSettingsNavigationRow(
                headline = stringResource(R.string.approvals_title),
                supporting = state.mode?.let { aidenApprovalModeLabel(it.mode) },
                supportingLoading = state.mode == null && !state.modeFailed,
                leadingIcon = Icons.Outlined.VerifiedUser,
                onClick = { onNavigate(AidenSettingsPage.APPROVALS) }
            )
        }
    }
}

/** Settings → Approvals: the Mac's mode, and a way into its rules. */
@Composable
fun AidenApprovalSettingsScreen(
    controller: AidenApprovalSettingsController,
    available: Boolean,
    onOpenRules: () -> Unit,
    onNavigateBack: () -> Unit
) {
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { if (available) controller.refresh() }

    AidenSettingsScaffold(title = stringResource(R.string.approvals_title), onNavigateBack = onNavigateBack) {
        if (!available) {
            item(key = "unsupported") {
                AidenSettingsGroup(title = null) {
                    row(dividerInset = AidenSettingsDefaults.DividerInset) {
                        AidenSettingsMessageRow(stringResource(R.string.approvals_unsupported))
                    }
                }
            }
            return@AidenSettingsScaffold
        }
        item(key = "mode") {
            val mode = state.mode
            AidenSettingsGroup(
                title = stringResource(R.string.approvals_mode_group),
                footer = stringResource(R.string.approvals_mode_footer),
                error = state.modeError,
                selectableGroup = mode != null
            ) {
                when {
                    mode != null -> ModeOrder.forEach { option ->
                        row(dividerInset = AidenSettingsDefaults.DividerInset) {
                            val enabled = state.canChoose(option)
                            AidenSettingsRadioRow(
                                headline = aidenApprovalModeLabel(option),
                                selected = mode.mode == option,
                                enabled = enabled || mode.mode == option,
                                supporting = stringResource(
                                    when (option) {
                                        AidenApprovalMode.ASK -> R.string.approvals_mode_ask_helper
                                        AidenApprovalMode.AUTO -> if (enabled) R.string.approvals_mode_auto_helper else R.string.approvals_mode_auto_unavailable
                                        AidenApprovalMode.NEVER -> R.string.approvals_mode_never_helper
                                    }
                                ),
                                onClick = { scope.launch { controller.setMode(option) } }
                            )
                        }
                    }
                    state.modeFailed -> row(dividerInset = AidenSettingsDefaults.DividerInset) {
                        AidenSettingsMessageRow(stringResource(R.string.approvals_mode_unavailable))
                    }
                    else -> repeat(3) { row { AidenSettingsSkeletonRow(leading = true) } }
                }
            }
        }
        item(key = "rules") {
            val count = state.rules?.rows?.size
            AidenSettingsGroup(title = null) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.approvals_rules),
                        supporting = stringResource(R.string.approvals_rules_supporting),
                        value = count?.let { pluralStringResource(R.plurals.approvals_rules_count, it, it) },
                        onClick = onOpenRules
                    )
                }
            }
        }
    }
}

/** Settings → Approvals → Rules: grouped like the desktop, each row changed or removed in place. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenApprovalRulesScreen(
    controller: AidenApprovalSettingsController,
    available: Boolean,
    onNavigateBack: () -> Unit
) {
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var adding by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { if (available) controller.refresh() }
    val rules = state.rules
    val canWrite = available && rules != null && !rules.unreadable

    AidenSettingsScaffold(
        title = stringResource(R.string.approvals_rules_title),
        onNavigateBack = onNavigateBack,
        actions = {
            if (canWrite) {
                IconButton(onClick = { adding = true; controller.loadPicker() }) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.approvals_add_rule))
                }
            }
        }
    ) {
        when {
            !available -> item(key = "unsupported") {
                AidenSettingsGroup(title = null) {
                    row(dividerInset = AidenSettingsDefaults.DividerInset) { AidenSettingsMessageRow(stringResource(R.string.approvals_unsupported)) }
                }
            }
            rules == null -> item(key = "loading") {
                AidenSettingsGroup(title = stringResource(R.string.approvals_group_allow)) {
                    if (state.rulesFailed) {
                        row(dividerInset = AidenSettingsDefaults.DividerInset) { AidenSettingsMessageRow(stringResource(R.string.approvals_rules_unavailable)) }
                    } else {
                        repeat(3) { row { AidenSettingsSkeletonRow(leading = false) } }
                    }
                }
            }
            else -> {
                if (rules.unreadable || state.rulesError != null) {
                    item(key = "error") {
                        Text(
                            if (rules.unreadable) stringResource(R.string.approvals_unreadable) else state.rulesError.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = AidenTheme.palette.danger,
                            modifier = Modifier.padding(horizontal = AidenSettingsDefaults.Gutter)
                        )
                    }
                }
                val groups = listOf(
                    AidenApprovalRuleGroup.ALLOW to (R.string.approvals_group_allow to R.string.approvals_empty_allow),
                    AidenApprovalRuleGroup.ASK to (R.string.approvals_group_ask to R.string.approvals_empty_ask),
                    AidenApprovalRuleGroup.BLOCK to (R.string.approvals_group_block to R.string.approvals_empty_block),
                    AidenApprovalRuleGroup.MAC to (R.string.approvals_group_mac to null)
                )
                groups.forEach { (group, copy) ->
                    val rows = state.rows(group)
                    val pending = state.pendingRules.filter { it.group == group }
                    if (group == AidenApprovalRuleGroup.MAC && rows.isEmpty()) return@forEach
                    item(key = "group-${group.wire}") {
                        AidenSettingsGroup(title = stringResource(copy.first)) {
                            rows.forEach { rule ->
                                row(dividerInset = AidenSettingsDefaults.DividerInset) {
                                    AidenApprovalRuleRowView(
                                        rule = rule,
                                        saving = rule.ref in state.savingRefs,
                                        writable = canWrite,
                                        onChange = { decision -> scope.launch { controller.changeRule(rule, decision) } },
                                        onRemove = { scope.launch { controller.removeRule(rule) } }
                                    )
                                }
                            }
                            pending.forEach { rule ->
                                row(dividerInset = AidenSettingsDefaults.DividerInset) {
                                    AidenSettingsValueRow(headline = rule.label, supporting = stringResource(R.string.approvals_adding))
                                }
                            }
                            val empty = copy.second
                            if (rows.isEmpty() && pending.isEmpty() && empty != null) {
                                row(dividerInset = AidenSettingsDefaults.DividerInset) { AidenSettingsMessageRow(stringResource(empty)) }
                            }
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        ModalBottomSheet(onDismissRequest = { adding = false }, containerColor = AidenTheme.palette.canvas) {
            AidenApprovalRulePicker(
                options = state.picker,
                failed = state.pickerFailed,
                onAdd = { option, decision ->
                    adding = false
                    scope.launch { controller.addRule(option, decision) }
                }
            )
        }
    }
}

@Composable
private fun aidenApprovalScopeText(rule: AidenApprovalRuleRow): String {
    val label = rule.scopeLabel
    return when (rule.scopeKind) {
        AidenApprovalRuleScopeKind.MAC -> stringResource(R.string.approvals_scope_mac)
        AidenApprovalRuleScopeKind.WORKSPACE -> label?.let { stringResource(R.string.approvals_scope_workspace, it) } ?: stringResource(R.string.approvals_scope_mac)
        AidenApprovalRuleScopeKind.BOT -> label?.let { stringResource(R.string.approvals_scope_bot, it) } ?: stringResource(R.string.approvals_scope_mac)
        AidenApprovalRuleScopeKind.CHAT -> label?.let { stringResource(R.string.approvals_scope_chat, it) } ?: stringResource(R.string.approvals_scope_mac)
    }
}

/** One rule: its title and scope, then the Allow / Ask / Block control the Mac offers, and Remove. */
@Composable
private fun AidenApprovalRuleRowView(
    rule: AidenApprovalRuleRow,
    saving: Boolean,
    writable: Boolean,
    onChange: (AidenApprovalRuleDecision) -> Unit,
    onRemove: () -> Unit
) {
    val palette = AidenTheme.palette
    val description = buildString {
        append(rule.kind)
        append(" · ")
        append(aidenApprovalScopeText(rule))
        if (rule.handOff == true) {
            append(" · ")
            append(stringResource(R.string.approvals_hand_off))
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(rule.title, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            Text(description, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        }
        val current = rule.decision
        val decisionLabel = stringResource(R.string.approvals_rule_decision, rule.title)
        val labels = aidenApprovalDecisionLabels()
        if (writable && current != null && rule.decisions.size > 1) {
            AidenSegmentedPillRow(
                options = rule.decisions,
                selected = current,
                onSelect = onChange,
                label = { labels.getValue(it) },
                enabled = !saving,
                segmentContentDescription = { "$decisionLabel: ${labels.getValue(it)}" }
            )
        }
        if (writable) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AidenTonalButton(
                    text = stringResource(if (saving) R.string.approvals_removing else R.string.approvals_remove),
                    onClick = onRemove,
                    enabled = !saving,
                    destructive = true
                )
            }
        }
    }
}

/** Add rule: pick one of the Mac's targets, then what happens when it comes up. */
@Composable
private fun AidenApprovalRulePicker(
    options: List<AidenApprovalRulePickerOption>?,
    failed: Boolean,
    onAdd: (AidenApprovalRulePickerOption, AidenApprovalRuleDecision) -> Unit
) {
    val palette = AidenTheme.palette
    var chosen by remember { mutableStateOf<AidenApprovalRulePickerOption?>(null) }
    var decision by remember { mutableStateOf(AidenApprovalRuleDecision.ALLOW) }
    val labels = aidenApprovalDecisionLabels()
    Column(
        Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = AidenSettingsDefaults.Gutter),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(stringResource(R.string.approvals_add_rule), style = MaterialTheme.typography.titleLarge, color = palette.foreground)
        Text(stringResource(R.string.approvals_add_rule_description), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        val option = chosen
        when {
            option != null -> {
                Text(stringResource(R.string.approvals_add_choose, option.label), style = MaterialTheme.typography.titleSmall, color = palette.foreground)
                AidenSegmentedPillRow(
                    options = AidenApprovalRuleDecision.entries.toList(),
                    selected = decision,
                    onSelect = { decision = it },
                    label = { labels.getValue(it) }
                )
                AidenPrimaryButton(
                    text = stringResource(R.string.approvals_add_rule),
                    onClick = { onAdd(option, decision) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            options == null && failed -> Text(stringResource(R.string.approvals_picker_unavailable), color = palette.secondary)
            options == null -> repeat(4) { AidenSettingsSkeletonRow(leading = false) }
            options.isEmpty() -> Text(stringResource(R.string.approvals_picker_empty), color = palette.secondary)
            else -> {
                val grouped = options.groupBy { it.group }
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
                    grouped.forEach { (group, members) ->
                        item(key = "h-$group") {
                            Text(
                                group,
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)
                            )
                        }
                        items(members, key = { it.target.toString() }) { member ->
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 48.dp)
                                    .clickable(role = Role.Button) { chosen = member }
                                    .padding(vertical = 10.dp)
                            ) {
                                Text(member.label, style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
                                member.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
                            }
                        }
                    }
                }
            }
        }
        Text(stringResource(R.string.approvals_add_rule_words), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        Spacer(Modifier.height(16.dp))
    }
}
