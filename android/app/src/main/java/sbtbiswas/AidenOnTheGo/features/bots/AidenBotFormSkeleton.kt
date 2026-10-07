package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonBlock

/**
 * Form-shaped placeholders for the Bot editor and Custom Access while the capability
 * catalog arrives. Both forms build their draft against the desktop's current catalog,
 * so they wait for it rather than editing a saved copy, and show its shape meanwhile.
 */
@Composable
internal fun AidenBotFormSkeleton(
    loadingDescription: String,
    modifier: Modifier = Modifier
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(20.dp),
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 12.dp)
            .clearAndSetSemantics { contentDescription = loadingDescription }
    ) {
        repeat(3) { section ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AidenSkeletonBlock(width = 96.dp, height = 12.dp)
                AidenSkeletonBlock(
                    height = if (section == 0) 160.dp else 104.dp,
                    shape = MaterialTheme.shapes.large
                )
            }
        }
    }
}
