package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenBotHandoff
import sbtbiswas.AidenOnTheGo.models.AidenBotHandoffKind
import sbtbiswas.AidenOnTheGo.models.AidenBotHandoffWire
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

const val AIDEN_BOT_HANDOFF_CARD_TAG = "bot_session_handoff_card"
const val AIDEN_BOT_PAUSED_CARD_TAG = "bot_session_paused_card"

/**
 * The host an action hand-off's Open names ("Open bank.example.com"), or null when only "Open"
 * can be shown. Only a page the Mac's own rule accepts (https, a host, no user name) is named.
 */
fun aidenBotHandoffOpenHost(url: String): String? {
    if (!AidenBotHandoffWire.isOpenUrl(url)) return null
    return runCatching { java.net.URI(url).host }.getOrNull()?.takeIf { it.isNotEmpty() }
}

/**
 * Contract revision 37 (`bot:handoffs`): a step the Bot hands back to the person, "Your turn: …",
 * shown beside the question and approval cards. Done and Skip answer it once, by its wait id; Open
 * opens the page it names in the phone's browser. A sign-in is finished in the Bot's own browser
 * on the Mac, so it offers Finish on your Mac and Skip instead (iOS and desktop parity). A step on
 * the Bot's own browser or computer ([AidenBotHandoff.onMac], revision 43) offers Finish on your
 * Mac, Skip and Done.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AidenBotHandoffCard(
    handoff: AidenBotHandoff,
    /** Connected, and nothing for this card is on its way. */
    canAnswer: Boolean,
    /** Finish on your Mac is on its way. */
    isFinishing: Boolean,
    /** What the Mac said after Finish on your Mac: whether it brought the Bot's browser forward. */
    macOpened: Boolean?,
    onDone: () -> Unit,
    onSkip: () -> Unit,
    onFinishOnMac: () -> Unit,
    /**
     * Revision 61 Macs: Take control first, then I'm done and Skip. The answers are the same
     * `done` and `skipped`; only this phone's card changes.
     */
    twoStep: Boolean = false
) {
    val palette = AidenTheme.palette
    val uriHandler = LocalUriHandler.current
    val signIn = handoff.kind == AidenBotHandoffKind.SIGN_IN
    var tookControl by remember(handoff.waitId) { mutableStateOf(AidenBotHandoffTaken.contains(handoff.waitId)) }
    val openUrl = handoff.openUrl?.takeIf { AidenBotHandoffWire.isOpenUrl(it) }
    // What Take control opens: the Bot's browser or computer on the Mac, or the page it names.
    val open: () -> Unit = {
        if (signIn || handoff.onMac) onFinishOnMac()
        else if (openUrl != null) runCatching { uriHandler.openUri(openUrl) }
    }
    val canOpenAgain = signIn || handoff.onMac || openUrl != null
    Surface(
        color = palette.raised,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth().testTag(AIDEN_BOT_HANDOFF_CARD_TAG)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (signIn) Icons.Outlined.Key else Icons.Outlined.PanTool,
                    contentDescription = null,
                    tint = palette.accent,
                    modifier = Modifier.size(18.dp)
                )
                Text(
                    text = stringResource(R.string.bot_handoff_title, handoff.action),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = palette.foreground
                )
            }
            handoff.why?.let { why ->
                Text(why, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
            if (handoff.onMac && macOpened == null) {
                Text(stringResource(R.string.bot_handoff_on_mac_detail), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            }
            macOpened?.let { opened ->
                Text(
                    stringResource(
                        when {
                            signIn && opened -> R.string.bot_handoff_mac_opened
                            signIn -> R.string.bot_handoff_mac_closed
                            opened -> R.string.bot_handoff_step_mac_opened
                            else -> R.string.bot_handoff_step_mac_closed
                        }
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            }
            if (twoStep) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 4.dp)
                ) {
                    if (!tookControl) {
                        AidenPrimaryButton(
                            text = stringResource(R.string.bot_handoff_take_control),
                            enabled = canAnswer && !isFinishing,
                            onClick = {
                                AidenBotHandoffTaken.add(handoff.waitId)
                                tookControl = true
                                open()
                            }
                        )
                    } else {
                        if (signIn) {
                            // A sign-in finishes on the Mac; Skip is its only answer here.
                            AidenPrimaryButton(text = stringResource(R.string.bot_handoff_skip), enabled = canAnswer, onClick = onSkip)
                        } else {
                            AidenPrimaryButton(text = stringResource(R.string.bot_handoff_im_done), enabled = canAnswer, onClick = onDone)
                            AidenTonalButton(text = stringResource(R.string.bot_handoff_skip), enabled = canAnswer, onClick = onSkip)
                        }
                        if (canOpenAgain) {
                            AidenTonalButton(text = stringResource(R.string.bot_handoff_open_again), enabled = canAnswer && !isFinishing, onClick = open)
                        }
                    }
                }
                return@Column
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 4.dp)
            ) {
                if (signIn) {
                    AidenPrimaryButton(
                        text = stringResource(R.string.bot_session_finish_on_mac),
                        enabled = canAnswer && !isFinishing,
                        onClick = onFinishOnMac
                    )
                    AidenTonalButton(text = stringResource(R.string.bot_handoff_skip), enabled = canAnswer, onClick = onSkip)
                } else {
                    if (handoff.onMac) {
                        AidenTonalButton(
                            text = stringResource(R.string.bot_session_finish_on_mac),
                            enabled = canAnswer && !isFinishing,
                            onClick = onFinishOnMac
                        )
                    }
                    handoff.openUrl?.takeIf { AidenBotHandoffWire.isOpenUrl(it) }?.let { url ->
                        val host = aidenBotHandoffOpenHost(url)
                        AidenTonalButton(
                            text = host?.let { stringResource(R.string.bot_handoff_open_host, it) } ?: stringResource(R.string.bot_handoff_open),
                            onClick = {
                                // No browser to take it: the card stays, and Done still answers.
                                runCatching { uriHandler.openUri(url) }
                            }
                        )
                    }
                    AidenTonalButton(text = stringResource(R.string.bot_handoff_skip), enabled = canAnswer, onClick = onSkip)
                    AidenPrimaryButton(text = stringResource(R.string.bot_handoff_done), enabled = canAnswer, onClick = onDone)
                }
            }
        }
    }
}

/**
 * Revision 61: the hand-offs this phone took control of, kept for the app's life so a card
 * drawn again (scrolled away, or the chat reopened) stays on its second step.
 */
object AidenBotHandoffTaken {
    private val taken = LinkedHashSet<String>()

    @Synchronized fun contains(waitId: String): Boolean = waitId in taken

    @Synchronized fun add(waitId: String) {
        if (taken.size >= 200) taken.remove(taken.first())
        taken += waitId
    }
}

/**
 * Revision 37: a Bot the person paused. It is a calm state, not a warning: Resume lifts the
 * pause, and a reply the pause cut short then shows the interrupted card with its own Resume
 * and Dismiss. Resume waits for [canResume] ([aidenBotPausedChatOffersResume]).
 */
@Composable
fun AidenBotPausedCard(botName: String, busy: Boolean, canResume: Boolean, onResume: () -> Unit) {
    val palette = AidenTheme.palette
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().testTag(AIDEN_BOT_PAUSED_CARD_TAG)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.PauseCircle, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                Text(stringResource(R.string.bot_paused_title, botName), style = MaterialTheme.typography.bodyLarge, color = palette.foreground)
            }
            Text(stringResource(R.string.bot_paused_detail, botName), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            AidenPrimaryButton(text = stringResource(R.string.bot_session_resume), enabled = canResume && !busy, onClick = onResume)
        }
    }
}

/** Revision 55. FlowRow keeps the host's ordered actions usable on narrow screens and large text. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AidenBotAccessRequestCard(
    request: sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequest,
    botName: String, canAnswer: Boolean, showsApprovalCount: Boolean = false,
    onAnswer: (sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequestChoice) -> Unit
) {
    val palette = AidenTheme.palette
    Surface(color = palette.raised, shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().testTag("bot_session_access_request_card")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.bot_access_title, botName, request.label),
                style = MaterialTheme.typography.titleSmall, color = palette.foreground)
            request.place?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = palette.secondary) }
            if (showsApprovalCount && request.approvalCount != null) Text("You’ve allowed this ${request.approvalCount} times in the last 2 weeks.",style = MaterialTheme.typography.bodySmall,color = palette.secondary)
            Text(request.why, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                request.choices.forEach { choice ->
                    val title = stringResource(when (choice) {
                        sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequestChoice.ONCE -> R.string.bot_access_once
                        sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequestChoice.ALWAYS -> R.string.bot_access_always
                        sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequestChoice.NOT_NOW -> R.string.bot_access_not_now
                    })
                    if (choice == sbtbiswas.AidenOnTheGo.models.AidenBotAccessRequestChoice.ONCE)
                        AidenPrimaryButton(title, enabled = canAnswer, onClick = { onAnswer(choice) })
                    else AidenTonalButton(title, enabled = canAnswer, onClick = { onAnswer(choice) })
                }
            }
        }
    }
}
