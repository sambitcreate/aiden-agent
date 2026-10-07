package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Feature token a paired Mac advertises once it serves Bot deletion. Until the Remote
 * contract revision that adds `DELETE /bots/{id}` lands, no host advertises it and every
 * Delete entry point stays hidden.
 */
const val AIDEN_BOT_DELETE_FEATURE = "bot-delete-v1"

/** Permanently deletes one Bot on the paired Mac. Supplied by the Remote client once the route exists. */
fun interface AidenBotDeleter {
    suspend fun delete(client: AidenRemoteClient, botId: String)
}

/** Delete is offered only when the Mac advertises it, this phone may change Bots, and a deleter exists. */
fun aidenBotDeleteAvailable(server: AidenServer?, deleter: AidenBotDeleter?): Boolean {
    if (server == null || deleter == null) return false
    return server.features.contains(AIDEN_BOT_DELETE_FEATURE) &&
        server.capabilities.contains(AidenRemoteCapability.BOT_WRITE)
}

data class AidenBotDeleteCopy(
    val title: String,
    val message: String,
    val confirm: String,
    val cancel: String
)

fun aidenBotDeleteCopy(name: String): AidenBotDeleteCopy {
    val displayName = name.trim().ifEmpty { "this Bot" }
    return AidenBotDeleteCopy(
        title = "Delete $displayName?",
        message = "This permanently erases $displayName's chat, memory, instructions, routines, files, and photo. This can't be undone.",
        confirm = "Delete Bot",
        cancel = "Cancel"
    )
}

@Composable
fun AidenBotDeleteDialog(
    name: String,
    isDeleting: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val copy = aidenBotDeleteCopy(name)
    AlertDialog(
        onDismissRequest = { if (!isDeleting) onDismiss() },
        title = { Text(copy.title) },
        text = { Text(copy.message) },
        confirmButton = {
            AidenDialogConfirmButton(
                text = copy.confirm,
                destructive = true,
                enabled = !isDeleting,
                onClick = onConfirm
            )
        },
        dismissButton = {
            AidenDialogDismissButton(text = copy.cancel, onClick = { if (!isDeleting) onDismiss() })
        },
        shape = AidenShape.Dialog,
        containerColor = palette.raised
    )
}
