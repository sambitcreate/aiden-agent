package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ForkRight
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenNoWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.ui.theme.AidenGroupCard
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.rememberAidenFullSheetState

/**
 * Revision 63: the Mac refused a turn because this chat's workspace folder is gone, and said the
 * whole chat may be continued in a new chat in another workspace. [message] is the Mac's reason.
 */
data class AidenContinueInNewChatOffer(val message: String)

/** Continue in a new chat (`chat:continue-in-new-chat`, contract revision 63). */
object AidenContinueInNewChat {
    const val ACTION_LABEL = "Continue in a new chat"
    const val PICKER_TITLE = "Continue in a new chat"
    const val PICKER_BODY = "The whole conversation is copied into a new chat in the workspace you choose. This chat stays as it is."
    const val NO_DESTINATIONS = "There is no other workspace on your Mac to continue in. Add one there, then try again."
    private const val FALLBACK_FAILURE = "The new chat could not be created."

    /**
     * The offer a refused send carries: a 409 `workspace_unavailable` whose details say the chat
     * may be continued elsewhere. Without details, or with `canContinueInNewChat` false, null.
     */
    fun offer(error: Throwable, chat: AidenChat?): AidenContinueInNewChatOffer? {
        val server = error as? AidenRemoteClientException.Server ?: return null
        if (chat == null || chat.isBotChat) return null
        if (server.statusCode != 409 || server.body.code != AidenRemoteErrorCode.WORKSPACE_UNAVAILABLE) return null
        if (server.body.details?.canContinueInNewChat != true) return null
        return AidenContinueInNewChatOffer(server.body.message)
    }

    /**
     * The workspaces a chat in [sourceWorkspaceId] may continue in, as the new-chat list names
     * them: hidden records fold into the Chats group, archived workspaces are left out, and so is
     * the chat's own workspace.
     */
    fun destinations(
        workspaces: List<AidenWorkspace>,
        sourceWorkspaceId: String,
        isArchived: (String) -> Boolean = { false }
    ): List<AidenWorkspace> =
        AidenNoWorkspace.grouped(workspaces).filter { workspace ->
            workspace.id != sourceWorkspaceId && (workspace.noWorkspace || !isArchived(workspace.id))
        }

    /**
     * Whether the offer still stands after [error]: only a destination whose folder is missing too
     * (409 `operation_in_progress`) or a request whose outcome is unknown leaves another try open.
     */
    fun offerSurvives(error: Throwable): Boolean {
        val server = error as? AidenRemoteClientException.Server ?: return true
        return server.statusCode == 409 && server.body.code == AidenRemoteErrorCode.OPERATION_IN_PROGRESS ||
            server.body.code == AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT
    }

    /** What a failed Continue tells the user: the Mac's own sentence when it sent one. */
    fun failureMessage(error: Throwable): String {
        val server = error as? AidenRemoteClientException.Server
        return server?.body?.message?.takeIf { it.isNotBlank() }
            ?: error.localizedMessage?.takeIf { it.isNotBlank() }
            ?: FALLBACK_FAILURE
    }
}

/** The Continue action under the Mac's refusal in the chat's error banner. */
@Composable
fun AidenContinueInNewChatAction(enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    AidenTonalButton(
        text = AidenContinueInNewChat.ACTION_LABEL,
        onClick = onClick,
        enabled = enabled,
        leadingIcon = Icons.Default.ForkRight,
        modifier = modifier
    )
}

/**
 * Picks the workspace a chat whose folder is gone continues in. Only workspace names are shown,
 * never a folder.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenContinueInNewChatPicker(
    destinations: List<AidenWorkspace>,
    isContinuing: Boolean,
    onPick: (AidenWorkspace) -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberAidenFullSheetState(),
        containerColor = palette.canvas
    ) {
        AidenContinueInNewChatPickerContent(destinations, isContinuing, onPick)
    }
}

@Composable
internal fun AidenContinueInNewChatPickerContent(
    destinations: List<AidenWorkspace>,
    isContinuing: Boolean,
    onPick: (AidenWorkspace) -> Unit
) {
    val palette = AidenTheme.palette
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
        Text(
            AidenContinueInNewChat.PICKER_TITLE,
            style = MaterialTheme.typography.titleMedium,
            color = palette.foreground,
            modifier = Modifier.semantics { heading() }
        )
        Spacer(Modifier.size(6.dp))
        Text(AidenContinueInNewChat.PICKER_BODY, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        Spacer(Modifier.size(16.dp))
        if (destinations.isEmpty()) {
            Text(AidenContinueInNewChat.NO_DESTINATIONS, style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)) {
                itemsIndexed(destinations, key = { _, workspace -> workspace.id }) { index, workspace ->
                    AidenGroupCard(
                        index = index,
                        count = destinations.size,
                        enabled = !isContinuing,
                        onClick = { onPick(workspace) }
                    ) {
                        Icon(Icons.Outlined.FolderOpen, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                        Text(
                            AidenNoWorkspace.label(workspace),
                            style = MaterialTheme.typography.bodyLarge,
                            color = palette.foreground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }
}
