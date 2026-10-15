package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityLevel
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenConnectedColumn
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth

// Advanced → Chat activity (spec §7): the page. The model and the previews' script live in
// `AidenBotChatActivityModel.kt`; the looping preview in `AidenBotChatActivityPreviewCard.kt`.

/**
 * What Chat activity needs from its surroundings, bound to one pairing and shared by every
 * Advanced sheet opened for it.
 *
 * A pick is saved from [launch]'s scope, which outlives the page (and Advanced, and the screen
 * behind it), so leaving mid-save doesn't cancel the request. [cache] is the one place a
 * confirmed pick is written to the Bot cache, so a pick that finishes after the person has gone
 * (or after the pairing changed, which [cache] checks) never depends on a view.
 */
class AidenBotChatActivityHost(
    /** The pairing's client now, or null once that pairing is gone or the phone is offline. */
    val client: () -> AidenRemoteClient?,
    /** Suspends until the Mac is connected; false when it can't be (unpaired, another pairing). */
    val waitForConnection: suspend () -> Boolean,
    val launch: (suspend () -> Unit) -> Unit,
    val cache: (AidenBotDetail) -> Unit
) {
    private class Live(val controller: AidenBotChatActivityController, var listener: (AidenBotDetail) -> Unit) {
        /** The page that set [listener] is gone. */
        var released = false
    }

    private val live = mutableMapOf<String, Live>()

    /** How many Bots have a controller (and its page's listener) held here. */
    internal val heldCount: Int get() = live.size

    /**
     * The controller for [bot]. One still saving is reused, so a sheet reopened mid-save never
     * forks a second writer on a stale revision; [onSaved] then goes to the newest sheet.
     */
    fun controller(bot: AidenBotDetail, onSaved: (AidenBotDetail) -> Unit): AidenBotChatActivityController {
        live[bot.id]?.takeIf { it.controller.state.value.isSaving }?.let {
            it.listener = onSaved
            it.released = false
            return it.controller
        }
        lateinit var entry: Live
        val controller = aidenBotChatActivityController(
            bot,
            client = client,
            onSaved = { saved ->
                cache(saved)
                entry.listener(saved)
            },
            waitForConnection = waitForConnection,
            // A page that left mid-save heard its last answer: let go of it now.
            onSettled = { if (entry.released) forget(bot.id, entry) }
        )
        entry = Live(controller, onSaved)
        live[bot.id] = entry
        return controller
    }

    /**
     * The page showing [controller] went away. Its listener goes now, or, while a save is still
     * running, once that save has reported (so the screens behind still hear it).
     */
    fun release(botId: String, controller: AidenBotChatActivityController) {
        val entry = live[botId]?.takeIf { it.controller === controller } ?: return
        entry.released = true
        if (!controller.state.value.isSaving) forget(botId, entry)
    }

    private fun forget(botId: String, entry: Live) {
        if (live[botId] === entry) live.remove(botId)
        entry.listener = {}
    }
}

/**
 * Waits for the Mac: true once [connection] is connected and a [client] exists, false as soon as
 * the phone needs pairing (nothing to wait for). Offline and connecting both keep waiting; the
 * controller bounds the wait.
 */
suspend fun <C : Any> aidenBotAwaitConnected(connection: Flow<AidenConnectionState>, client: Flow<C?>): Boolean =
    combine(connection, client) { state, current -> state to current }
        .first { (state, current) -> state == AidenConnectionState.NEEDS_PAIRING || (state == AidenConnectionState.CONNECTED && current != null) }
        .first == AidenConnectionState.CONNECTED

/**
 * The host for the pairing that is active now; a pick never reaches another pairing's Mac. It is
 * pinned to the pairing itself, not the Mac's id, so an unpair and re-pair of the same Mac is
 * another pairing.
 */
fun AidenRemoteCoordinator.botChatActivityHost(): AidenBotChatActivityHost = pairingMemo("bot-chat-activity-host") {
    val pairing = activePairing
    fun samePairing() = holdsPairing(pairing)
    AidenBotChatActivityHost(
        client = { pairedClient(pairing) },
        waitForConnection = { samePairing() && aidenBotAwaitConnected(connectionState, client.map { pairedClient(pairing) }) && samePairing() },
        launch = { block -> launchDetached(block) },
        cache = pinnedBotCache()
    )
}

/**
 * Tells the screens behind Advanced about Chat activity picks once: when Advanced closes, with
 * the newest saved Bot. A pick that finishes after that is reported at once. Advanced itself
 * keeps its baseline current on every pick, so this is only about the screens it covers.
 */
class AidenBotChatActivityReporter(private val report: (AidenBotDetail) -> Unit) {
    private var pending: AidenBotDetail? = null
    private var closed = false

    fun saved(detail: AidenBotDetail) {
        if (closed) report(detail) else pending = detail
    }

    /** Advanced is going away: report what was saved while it was open. Safe to call twice. */
    fun close() {
        closed = true
        val detail = pending ?: return
        pending = null
        report(detail)
    }

    /** The screen behind already has the newest Bot (Advanced's own Save returned it). */
    fun settle() {
        pending = null
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotChatActivityDialog(
    botName: String,
    controller: AidenBotChatActivityController,
    launch: (suspend () -> Unit) -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val state by controller.state.collectAsState()
    // Leaving the page leaves the error behind; a save still running carries on without it.
    DisposableEffect(controller) { onDispose { controller.dismissError() } }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            containerColor = palette.canvas,
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.bot_chat_activity_title), fontWeight = FontWeight.SemiBold) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .aidenReadableWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = AidenUi.ScreenGutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(AidenUi.SectionGap)
            ) {
                Text(stringResource(R.string.bot_chat_activity_description, botName), color = palette.secondary, style = MaterialTheme.typography.bodyMedium)
                state.saveFailure?.let { failure ->
                    Text(
                        stringResource(
                            when (failure) {
                                AidenBotChatActivityFailure.OFFLINE -> R.string.bot_chat_activity_save_unreachable
                                AidenBotChatActivityFailure.CONFLICT -> R.string.bot_chat_activity_save_conflict
                                AidenBotChatActivityFailure.GENERIC -> R.string.bot_chat_activity_save_failed
                            }
                        ),
                        color = aidenBotErrorTextColor(),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    )
                }
                AidenBotChatActivityGroup(stringResource(R.string.bot_chat_activity_level_title)) {
                    val levels = AidenBotChatActivityLevel.entries
                    levels.forEachIndexed { index, level ->
                        AidenBotChatActivityChoice(
                            index = index,
                            count = levels.size,
                            title = stringResource(level.label),
                            detail = stringResource(level.detail),
                            recommended = level == AidenBotChatActivityLevel.QUIET,
                            selected = state.value.level == level,
                            onPick = { launch { controller.pick(state.value.copy(level = level)) } }
                        ) { AidenBotChatActivityPreviewCard(level = level, wording = state.value.wording) }
                    }
                }
                AidenBotChatActivityGroup(stringResource(R.string.bot_chat_activity_wording_title)) {
                    val wordings = AidenBotChatActivityWording.entries
                    wordings.forEachIndexed { index, wording ->
                        AidenBotChatActivityChoice(
                            index = index,
                            count = wordings.size,
                            title = stringResource(wording.label),
                            detail = stringResource(wording.detail),
                            recommended = false,
                            selected = state.value.wording == wording,
                            onPick = { launch { controller.pick(state.value.copy(wording = wording)) } }
                        ) { AidenBotChatActivityPreviewCard(level = AidenBotChatActivityLevel.QUIET, wording = wording) }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(R.string.bot_chat_activity_phones_title),
                        style = MaterialTheme.typography.labelLarge,
                        color = palette.secondary,
                        modifier = Modifier.padding(horizontal = 4.dp).semantics { heading() }
                    )
                    Text(
                        stringResource(R.string.bot_chat_activity_phones_description),
                        color = palette.secondary,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 4.dp)
                    )
                    AidenBotChatActivityPreviewCard(
                        level = AidenBotChatActivityLevel.QUIET,
                        wording = state.value.wording,
                        description = stringResource(R.string.bot_chat_activity_preview)
                    )
                }
            }
        }
    }
}

@Composable
private fun AidenBotChatActivityGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    val palette = AidenTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = palette.secondary,
            modifier = Modifier.padding(horizontal = 4.dp).semantics { heading() }
        )
        AidenConnectedColumn(modifier = Modifier.selectableGroup(), content = content)
    }
}

/**
 * A radio row: the radio and the tonal fill show the choice; there is no border. It is never
 * disabled while a save runs, because a pick applies at once.
 */
@Composable
private fun AidenBotChatActivityChoice(
    index: Int,
    count: Int,
    title: String,
    detail: String,
    recommended: Boolean,
    selected: Boolean,
    onPick: () -> Unit,
    preview: @Composable () -> Unit
) {
    val palette = AidenTheme.palette
    AidenGroupCard(
        index = index,
        count = count,
        modifier = Modifier.semantics { this.selected = selected },
        selected = selected,
        role = Role.RadioButton,
        onClick = onPick,
        verticalAlignment = Alignment.Top
    ) {
        RadioButton(selected = selected, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = palette.accent))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, color = palette.foreground, style = MaterialTheme.typography.bodyLarge)
                if (recommended) {
                    Text(stringResource(R.string.bot_chat_activity_recommended), color = palette.secondary, style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(detail, color = palette.secondary, style = MaterialTheme.typography.bodySmall)
            preview()
        }
    }
}
