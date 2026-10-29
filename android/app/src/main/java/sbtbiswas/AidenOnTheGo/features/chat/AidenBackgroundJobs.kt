package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJob
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobCopy
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobsState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import java.time.Instant

const val AIDEN_BACKGROUND_JOBS_CHIP_TAG = "aiden-background-jobs-chip"

/** Revision 48: "2 in background" beside the composer while the agent has something running on the Mac. */
@Composable
fun AidenBackgroundJobsChip(running: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val title = AidenBackgroundJobCopy.chip(running) ?: return
    AidenProgressChip(
        icon = Icons.Default.Terminal,
        label = title,
        description = title,
        onClick = onClick,
        modifier = modifier.testTag(AIDEN_BACKGROUND_JOBS_CHIP_TAG),
        accessibilityLabel = AidenBackgroundJobCopy.chipDescription(running)
    )
}

/** The chat's jobs, how long each has run or how it ended, the addresses it serves on the Mac, and Stop. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBackgroundJobsSheet(
    state: AidenBackgroundJobsState,
    canStop: Boolean,
    onStop: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = Instant.now()
        }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
        containerColor = palette.raised
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Background jobs", style = MaterialTheme.typography.titleMedium, color = palette.foreground)
            Spacer(Modifier.size(12.dp))
            if (state.jobs.isEmpty()) {
                Text("Nothing in the background", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                items(state.jobs, key = { it.id }) { job ->
                    AidenBackgroundJobRow(job, now, canStop, job.id in state.stoppingJobIds) { onStop(job.id) }
                }
            }
            state.errorMessage?.let {
                Spacer(Modifier.size(10.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = palette.danger)
            }
            Spacer(Modifier.size(14.dp))
            Text(
                "These run on your Mac. Open an address in a browser there.",
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary
            )
        }
    }
}

@Composable
private fun AidenBackgroundJobRow(job: AidenBackgroundJob, now: Instant, canStop: Boolean, isStopping: Boolean, onStop: () -> Unit) {
    val palette = AidenTheme.palette
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(
            Icons.Default.Terminal,
            contentDescription = null,
            tint = if (job.isRunning) palette.accent else palette.secondary,
            modifier = Modifier.size(20.dp)
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(job.label, style = MaterialTheme.typography.bodyLarge, color = palette.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                AidenBackgroundJobCopy.status(job, now),
                style = MaterialTheme.typography.bodySmall,
                color = if (job.state == AidenBackgroundJob.State.FAILED && !job.isFromCommand) palette.danger else palette.secondary
            )
            AidenBackgroundJobCopy.addresses(job)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = palette.secondary)
            }
        }
        if (job.isRunning && canStop) {
            AidenTonalButton(
                text = "Stop",
                onClick = onStop,
                enabled = !isStopping,
                destructive = true,
                modifier = Modifier.semantics { contentDescription = "Stop ${job.label}" }
            )
        }
    }
}
