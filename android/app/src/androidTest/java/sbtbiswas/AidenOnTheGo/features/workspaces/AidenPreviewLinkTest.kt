package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.runtime.SideEffect
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.chat.AidenAnnotationTag
import sbtbiswas.AidenOnTheGo.features.chat.buildAidenFormattedMessage
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

class AidenPreviewLinkTest {
    @get:Rule val compose = createComposeRule()
    @Test fun markdownAndToolJsonExposeExactPreviewUrlOnlyAsLinkAnnotations() {
        var result: AnnotatedString? = null
        compose.setContent {
            AidenTheme {
                val formatted = buildAidenFormattedMessage("[Open preview](http://100.80.1.2:3000) {\"url\":\"http://100.80.1.2:3000\"} https://example.com", AidenTheme.palette, false)
                SideEffect { result = formatted }
            }
        }
        compose.runOnIdle {
            assertEquals(listOf("http://100.80.1.2:3000", "http://100.80.1.2:3000", "https://example.com"), result!!.getStringAnnotations(AidenAnnotationTag.LINK.name, 0, result!!.length).map { it.item })
        }
    }
}
