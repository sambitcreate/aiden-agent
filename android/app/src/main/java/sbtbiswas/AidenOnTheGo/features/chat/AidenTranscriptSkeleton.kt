package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock

/**
 * Transcript-shaped placeholders for a chat opened with nothing saved on this phone:
 * a user bubble on the trailing edge and an assistant reply of a few lines. Saved
 * chats never show it; their transcript renders at once and refreshes underneath.
 */
@Composable
fun AidenTranscriptSkeleton(modifier: Modifier = Modifier) {
    Column(
        verticalArrangement = Arrangement.spacedBy(24.dp),
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .clearAndSetSemantics { contentDescription = "Loading conversation" }
    ) {
        repeat(2) {
            AidenSkeletonBlock(
                modifier = Modifier
                    .fillMaxWidth(0.58f)
                    .align(Alignment.End),
                width = null,
                height = 44.dp,
                shape = MaterialTheme.shapes.large
            )
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                AidenSkeletonBlock(Modifier.fillMaxWidth(0.92f), width = null)
                AidenSkeletonBlock(Modifier.fillMaxWidth(0.84f), width = null)
                AidenSkeletonBlock(Modifier.fillMaxWidth(0.48f), width = null)
            }
        }
    }
}
