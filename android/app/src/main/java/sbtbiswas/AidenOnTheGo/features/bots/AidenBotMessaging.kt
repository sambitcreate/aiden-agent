package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.*

fun aidenBotMessagingAvailable(capabilities: List<AidenRemoteCapability>, settings: AidenBotMessagingSettings?) =
    AidenRemoteCapability.BOT_MESSAGING in capabilities && settings != null

fun aidenBotMessagingControlsEnabled(settings: AidenBotMessagingSettings?, canWrite: Boolean, saving: Boolean) =
    settings?.enabled == true && canWrite && !saving

/**
 * Revision 61: the single Can message other Bots switch reads on only when both stored
 * directions are on; flipping it writes both.
 */
fun aidenBotMessagingSingleSwitch(value: AidenBotMessaging): Boolean = value.receive && value.send

fun aidenBotMessagingSingleSwitchPatch(on: Boolean): AidenBotMessagingPatch = AidenBotMessagingPatch(receive = on, send = on)

data class AidenBotMessagingState(
    val settings: AidenBotMessagingSettings? = null,
    val saving: Boolean = false,
    val failed: Boolean = false
)

/** One save at a time; a lost response is reconciled by reading, never resending. */
class AidenBotMessagingController(
    private val send: suspend (Boolean) -> AidenBotMessagingSettings,
    private val read: suspend () -> AidenBotMessagingSettings?,
    private val current: () -> Boolean = { true }
) {
    private val mutable = MutableStateFlow(AidenBotMessagingState())
    val state = mutable.asStateFlow()
    private var generation = 0
    val readGeneration: Int get() = generation

    fun adopt(value: AidenBotMessagingSettings?, generation: Int? = null) {
        if (generation != null && generation != this.generation) return
        if (current() && !mutable.value.saving) mutable.value = mutable.value.copy(settings = value)
    }

    suspend fun refresh() {
        val ticket = generation
        try {
            val fresh = read()
            if (ticket == generation) adopt(fresh)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* Keep the last authenticated state; unknown remains disabled. */ }
    }

    suspend fun save(enabled: Boolean) {
        val previous = mutable.value.settings ?: return
        if (!current() || mutable.value.saving) return
        generation++
        mutable.value = AidenBotMessagingState(AidenBotMessagingSettings(enabled), saving = true)
        try {
            val fresh = send(enabled)
            if (current()) mutable.value = AidenBotMessagingState(fresh)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            val fresh = try { read() } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
            if (current()) mutable.value = AidenBotMessagingState(fresh ?: previous, failed = fresh?.enabled != enabled)
        }
    }
}

fun AidenRemoteCoordinator.botMessagingController(): AidenBotMessagingController = pairingMemo("bot-messaging") {
    val pairing = activePairing
    AidenBotMessagingController(
        send = { enabled -> aidenBotHeldRequest(waitForConnection = { holdsPairing(pairing) && pairedClient(pairing) != null }) {
            requireNotNull(pairedClient(pairing)).setBotMessaging(enabled)
        } },
        read = { aidenBotHeldRequest(waitForConnection = { holdsPairing(pairing) && pairedClient(pairing) != null }) {
            requireNotNull(pairedClient(pairing)).bots()
        }.messaging },
        current = { holdsPairing(pairing) }
    )
}

@Composable
fun AidenBotMessagingGlobalControl(coordinator: AidenRemoteCoordinator) {
    val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val controller = remember(coordinator.activePairing) { coordinator.botMessagingController() }
    val state by controller.state.collectAsStateWithLifecycle()
    val granted = server?.capabilities.orEmpty()
    LaunchedEffect(client, granted) {
        if (AidenRemoteCapability.BOT_MESSAGING in granted) controller.refresh()
    }
    if (aidenBotMessagingAvailable(granted, state.settings)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = AidenUi.ScreenGutter)) {
            AidenBotMessagingSwitch(stringResource(R.string.bot_messaging_global), state.settings!!.enabled,
                !state.saving && client != null && AidenRemoteCapability.BOT_WRITE in granted) {
                coordinator.launchDetached { controller.save(it) }
            }
            if (state.failed) Text(stringResource(R.string.bot_save_failed), color = AidenTheme.palette.secondary)
        }
    }
}

@Composable
fun AidenBotMessagingSection(coordinator: AidenRemoteCoordinator, bot: AidenBotDetail, locked: Boolean, onSaved: (AidenBotDetail) -> Unit) {
    val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val client by coordinator.client.collectAsStateWithLifecycle()
    val granted = server?.capabilities.orEmpty()
    val controller = remember(coordinator.activePairing) { coordinator.botMessagingController() }
    val global by controller.state.collectAsStateWithLifecycle()
    val saveHost = remember(coordinator.activePairing) { coordinator.botSaveHost() }
    val updatedSaved by rememberUpdatedState(onSaved)
    val editor = remember(bot.id, saveHost) {
        AidenBotIdentityEditor(bot,
            save = { baseline, patch -> saveHost.connected().updateBotIdentity(baseline.id, baseline.revision, patch, supportsBotMessaging = true) },
            refresh = { saveHost.connected().bot(bot.id) },
            onSaved = { saveHost.cache(it); updatedSaved(it) }, onShown = saveHost.show,
            waitForConnection = saveHost.waitForConnection)
    }
    val edit by editor.state.collectAsStateWithLifecycle()
    LaunchedEffect(bot) { editor.adopt(bot) }
    LaunchedEffect(client, granted) { if (AidenRemoteCapability.BOT_MESSAGING in granted) controller.refresh() }
    if (AidenRemoteCapability.BOT_MESSAGING !in granted || bot.botMessaging == null) return
    val value = edit.bot.botMessaging ?: return
    val enabled = aidenBotMessagingControlsEnabled(global.settings, !locked && client != null && AidenRemoteCapability.BOT_WRITE in granted, global.saving || edit.isSaving)
    Column {
        Text(stringResource(R.string.bot_messaging_other_bots), style = MaterialTheme.typography.titleSmall, color = AidenTheme.palette.secondary)
        if (coordinator.installationStore.activeInstallation?.offersBotUx == true) {
            // Revision 61: one switch, as on the Mac. The wire keeps both directions.
            AidenBotMessagingSwitch(stringResource(R.string.bot_messaging_single), aidenBotMessagingSingleSwitch(value), enabled) {
                coordinator.launchDetached { editor.edit(AidenBotIdentityPatch(botMessaging = aidenBotMessagingSingleSwitchPatch(it))) }
            }
        } else {
            AidenBotMessagingSwitch(stringResource(R.string.bot_messaging_receive, bot.name), value.receive, enabled) {
                coordinator.launchDetached { editor.edit(AidenBotIdentityPatch(botMessaging = AidenBotMessagingPatch(receive = it))) }
            }
            AidenBotMessagingSwitch(stringResource(R.string.bot_messaging_send, bot.name), value.send, enabled) {
                coordinator.launchDetached { editor.edit(AidenBotIdentityPatch(botMessaging = AidenBotMessagingPatch(send = it))) }
            }
        }
        if (global.settings?.enabled == false) Text(stringResource(R.string.bot_messaging_globally_off), color = AidenTheme.palette.secondary)
        else if (global.settings == null) Text(stringResource(R.string.bot_messaging_check_connection), color = AidenTheme.palette.secondary)
        if (edit.failure != null) Text(stringResource(R.string.bot_save_failed), color = AidenTheme.palette.secondary)
    }
}

@Composable
private fun AidenBotMessagingSwitch(label: String, checked: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), color = AidenTheme.palette.foreground)
        Switch(checked = checked, onCheckedChange = change, enabled = enabled, colors = aidenSwitchColors(),
            modifier = Modifier.semantics { contentDescription = label })
    }
}
