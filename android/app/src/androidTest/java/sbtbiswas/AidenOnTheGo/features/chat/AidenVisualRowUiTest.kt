package sbtbiswas.AidenOnTheGo.features.chat

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenChatVisual
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenVisualRowUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val snapshotBytes: ByteArray by lazy {
        val bitmap = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.rgb(104, 91, 220))
        ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            bitmap.recycle()
            output.toByteArray()
        }
    }

    private val snapshot by lazy {
        AidenMessageAttachment(
            id = "visual-snapshot_${"2".repeat(64)}",
            name = "Plan options.png",
            mimeType = "image/png",
            kind = AidenAttachmentKind.IMAGE,
            size = snapshotBytes.size
        )
    }

    private fun show(
        visual: AidenChatVisual,
        attachments: List<AidenMessageAttachment>,
        onOpenInteractive: ((AidenVisualViewerRequest) -> Unit)? = null
    ) {
        compose.setContent {
            AidenTheme {
                AidenVisualRow(
                    visual = visual,
                    attachments = attachments,
                    loadAttachmentImage = { if (it.id == snapshot.id) snapshotBytes else null },
                    palette = AidenTheme.palette,
                    onOpenInteractive = onOpenInteractive
                )
            }
        }
    }

    @Test
    fun snapshotIsDescribedByItsTitleWithFallbackTextBeneath() {
        show(
            AidenChatVisual(
                id = "ui_fixture_01", kind = "ui", title = "Plan options", toolCallId = "call-2",
                fallbackText = "Solo: \$12.00\nTeam: \$60.00", snapshotAttachmentId = snapshot.id
            ),
            listOf(snapshot)
        )
        compose.waitUntil(5_000) {
            runCatching { compose.onNodeWithContentDescription("Plan options").assertExists() }.isSuccess
        }
        compose.onNodeWithContentDescription("Plan options").assertIsDisplayed()
        compose.onNodeWithText("Team: \$60.00", substring = true).assertIsDisplayed()
    }

    @Test
    fun withoutASnapshotTheFallbackTextStandsAlone() {
        show(
            AidenChatVisual(
                id = "ui_fixture_01", kind = "ui", title = "Plan options",
                fallbackText = "Solo: \$12.00", snapshotAttachmentId = snapshot.id
            ),
            attachments = emptyList()
        )
        compose.onNodeWithText("Solo: \$12.00").assertIsDisplayed()
        compose.onNodeWithContentDescription("Plan options").assertDoesNotExist()
    }

    @Test
    fun withNeitherSnapshotNorFallbackTheTitleStandsAlone() {
        show(AidenChatVisual(id = "artifact_fixture_01", kind = "html", title = "Weekly total"), emptyList())
        compose.onNodeWithText("Weekly total").assertIsDisplayed()
    }

    @Test
    fun withoutASnapshotOpenInteractiveIsSpokenWithItsVisibleLabelAndOpensTheVisual() {
        val opened = mutableListOf<AidenVisualViewerRequest>()
        show(
            AidenChatVisual(id = "ui_fixture_02", kind = "ui", title = "Plan options", fallbackText = "Solo: \$12.00"),
            attachments = emptyList(),
            onOpenInteractive = { opened += it }
        )
        compose.onNodeWithText("Solo: \$12.00").assertIsDisplayed()

        // The spoken name starts with the visible label (WCAG 2.5.3) and adds the title.
        val button = compose.onNode(hasClickAction() and hasContentDescription("Open interactive", substring = true))
        button.assertIsDisplayed()
        val spoken = button.fetchSemanticsNode().config[SemanticsProperties.ContentDescription].joinToString(" ")
        assertTrue("\"$spoken\" should contain the visible label", spoken.contains("Open interactive"))
        assertTrue("\"$spoken\" should name the visual", spoken.contains("Plan options"))

        button.performClick()
        assertEquals(listOf("ui_fixture_02"), opened.map { it.visual.id })
        assertNull("A snapshot-less visual opens without one", opened.single().snapshot)
    }

    @Test
    fun longFallbackTextCollapsesWithAnExpandAffordance() {
        val lines = (1..14).joinToString("\n") { "Plan line $it" }
        show(
            AidenChatVisual(id = "ui_long", kind = "ui", title = "Long plan", fallbackText = lines),
            emptyList()
        )
        compose.onNodeWithText("Show more").assertIsDisplayed().performClick()
        compose.onNodeWithText("Show less").assertIsDisplayed()
    }
}
