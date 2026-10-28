package sbtbiswas.AidenOnTheGo.features.chat

import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.models.AidenBrowserRecordingFile
import sbtbiswas.AidenOnTheGo.models.AidenBrowserRecordingLoad
import sbtbiswas.AidenOnTheGo.models.AidenBrowserRecordingRecap
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

/**
 * What a recording card can do in this chat (contract revision 44): read the
 * video from the Mac, and let the saved file go once the player closes.
 */
@Stable
internal class AidenBrowserRecordingPlayback(
    val load: suspend (AidenBrowserRecordingRecap) -> AidenBrowserRecordingLoad,
    val release: (AidenBrowserRecordingFile) -> Unit
)

/**
 * Null where the Mac does not serve recordings (it never announced
 * `chat-browser-recordings-v1`): the card then says to watch on the Mac.
 */
internal val LocalAidenBrowserRecordingPlayback = compositionLocalOf<AidenBrowserRecordingPlayback?> { null }

private enum class AidenBrowserRecordingPhase { IDLE, LOADING, MISSING, FAILED }

/**
 * The video the agent recorded of a browser tab, under its activity line, so the
 * owner can watch what the agent saw. The bytes stay on the Mac until Play is
 * pressed. A borderless tonal card like the web extract recap it sits beside.
 */
@Composable
internal fun AidenBrowserRecordingCard(
    recording: AidenBrowserRecordingRecap,
    palette: AidenPalette,
    modifier: Modifier = Modifier
) {
    val playback = LocalAidenBrowserRecordingPlayback.current
    val scope = rememberCoroutineScope()
    var phase by remember(recording.id) { mutableStateOf(AidenBrowserRecordingPhase.IDLE) }
    var playing by remember(recording.id) { mutableStateOf<AidenBrowserRecordingFile?>(null) }
    val duration = recording.durationLabel
    val description = stringResource(R.string.chat_browser_recording_cd, duration)
    Surface(
        color = palette.raised,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = description }
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(
                    imageVector = Icons.Outlined.Videocam,
                    contentDescription = null,
                    tint = palette.secondary,
                    modifier = Modifier.size(14.dp)
                )
                Text(
                    text = stringResource(R.string.chat_browser_recording_title),
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                Text(
                    text = stringResource(R.string.chat_browser_recording_meta, duration, recording.sizeLabel),
                    style = MaterialTheme.typography.labelMedium,
                    color = palette.secondary.copy(alpha = 0.8f),
                    maxLines = 1
                )
            }
            if (playback == null) {
                Text(
                    text = stringResource(R.string.chat_browser_recording_on_mac),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val loading = phase == AidenBrowserRecordingPhase.LOADING
                    AidenTonalButton(
                        text = stringResource(
                            if (loading) R.string.chat_browser_recording_loading else R.string.chat_browser_recording_play
                        ),
                        enabled = !loading,
                        leadingIcon = Icons.Default.PlayArrow,
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                        onClick = {
                            phase = AidenBrowserRecordingPhase.LOADING
                            scope.launch {
                                val result = playback.load(recording)
                                phase = when (result) {
                                    is AidenBrowserRecordingLoad.Ready -> AidenBrowserRecordingPhase.IDLE
                                    AidenBrowserRecordingLoad.Missing -> AidenBrowserRecordingPhase.MISSING
                                    AidenBrowserRecordingLoad.Failed -> AidenBrowserRecordingPhase.FAILED
                                }
                                playing = (result as? AidenBrowserRecordingLoad.Ready)?.recording
                            }
                        }
                    )
                    val status = when (phase) {
                        AidenBrowserRecordingPhase.MISSING -> R.string.chat_browser_recording_missing
                        AidenBrowserRecordingPhase.FAILED -> R.string.chat_browser_recording_failed
                        AidenBrowserRecordingPhase.IDLE, AidenBrowserRecordingPhase.LOADING -> null
                    }
                    if (status != null) {
                        Text(
                            text = stringResource(status),
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.secondary,
                            modifier = Modifier.weight(1f, fill = false)
                        )
                    }
                }
            }
        }
    }
    playing?.let { file ->
        // Closing the player, or the card leaving the screen, drops the saved video.
        DisposableEffect(file) {
            onDispose { playback?.release?.invoke(file) }
        }
        AidenBrowserRecordingPlayer(recording = file, title = description, onDismiss = { playing = null })
    }
}

/** Full screen playback with the platform's own controls; Android plays both MP4 and WebM. */
@Composable
private fun AidenBrowserRecordingPlayer(
    recording: AidenBrowserRecordingFile,
    title: String,
    onDismiss: () -> Unit
) {
    var unplayable by remember(recording) { mutableStateOf(false) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // A video stage is black in every theme, as it is on the desktop.
        Surface(color = Color.Black, modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.fillMaxSize()) {
                if (unplayable) {
                    Text(
                        text = stringResource(R.string.chat_browser_recording_unplayable),
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.White,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(24.dp)
                    )
                } else {
                    AndroidView(
                        factory = { context ->
                            VideoView(context).apply {
                                contentDescription = title
                                val controller = MediaController(context)
                                controller.setAnchorView(this)
                                setMediaController(controller)
                                setOnErrorListener { _, _, _ ->
                                    unplayable = true
                                    true
                                }
                                setVideoURI(Uri.fromFile(recording.file))
                                start()
                            }
                        },
                        modifier = Modifier.align(Alignment.Center).fillMaxWidth(),
                        onRelease = { view -> view.stopPlayback() }
                    )
                }
                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = stringResource(R.string.action_close),
                        tint = Color.White
                    )
                }
            }
        }
    }
}
