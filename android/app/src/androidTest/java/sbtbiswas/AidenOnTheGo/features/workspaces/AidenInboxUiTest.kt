package sbtbiswas.AidenOnTheGo.features.workspaces

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceMode
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenInbox
import sbtbiswas.AidenOnTheGo.models.AidenInboxProjection
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.io.FileOutputStream
import java.time.Duration
import java.time.Instant

/** The Inbox list on a fixture: sections, swipes, TalkBack actions, and screenshots. */
@RunWith(AndroidJUnit4::class)
class AidenInboxUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val now = Instant.now()
    private val names = mapOf("ws-1" to "Aiden Agent", "ws-2" to "Notes")

    private fun chat(
        id: String,
        title: String,
        ago: Duration,
        workspaceId: String = "ws-1",
        rowState: String? = null,
        unread: Boolean = false,
        failed: Boolean = false,
        pinnedAt: Instant? = null
    ) = AidenChatSummary(
        id = id,
        workspaceId = workspaceId,
        title = title,
        titlePending = false,
        createdAt = now.minus(ago).minus(Duration.ofDays(1)),
        updatedAt = now.minus(ago),
        revision = "rev-$id",
        activity = if (rowState != null) AidenChatSummaryActivity.ACTIVE else AidenChatSummaryActivity.IDLE,
        rowStateWire = rowState,
        unread = unread,
        lastRunFailed = failed,
        attentionSince = if (rowState != null && rowState != "working") now.minus(ago) else null,
        runStartedAt = if (rowState == "working") now.minus(ago) else null,
        lastAssistantAt = now.minus(ago),
        pinnedAt = pinnedAt
    )

    private val fixture = listOf(
        chat("approve", "Deploy the docs site", Duration.ofMinutes(4), rowState = "needs_approval"),
        chat("question", "Which branch should I use?", Duration.ofMinutes(12), workspaceId = "ws-2", rowState = "needs_input"),
        chat("failed", "Nightly test run", Duration.ofMinutes(40), unread = true, failed = true),
        chat("pinned", "Release checklist", Duration.ofHours(3), pinnedAt = now.minus(Duration.ofDays(1))),
        chat("update", "Summarize the review", Duration.ofMinutes(25), unread = true),
        chat("earlier", "Refactor the sidebar", Duration.ofHours(5), workspaceId = "ws-2"),
        chat("earlier-2", "Draft the changelog", Duration.ofDays(2)),
        chat("working", "Indexing the repository", Duration.ofMinutes(2), rowState = "working")
    )

    private class Calls {
        val markRead = mutableStateListOf<String>()
        val done = mutableStateListOf<String>()
        val snooze = mutableStateListOf<String>()
        val opened = mutableStateListOf<String>()
    }

    @Composable
    private fun InboxFixture(calls: Calls, snackbar: SnackbarHostState? = null) {
        val projection = AidenInboxProjection.make(fixture, names, openChatId = null, now = now)
        val palette = AidenTheme.palette
        Box(Modifier.width(400.dp).height(780.dp).background(palette.sidebar).testTag("inbox_fixture")) {
            Column {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 14.dp)
                ) {
                    Text("Inbox", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                    AidenInboxBetaBadge()
                }
                LazyColumn(Modifier.fillMaxWidth()) {
                    aidenInboxItems(
                        projection = projection,
                        workspaceNames = names,
                        now = now,
                        offers = AidenInboxRowOffers(markRead = { it.unread }, triage = { AidenInbox.offersDoneAndSnooze(it) }),
                        onOpen = { calls.opened += it },
                        onMarkRead = { calls.markRead += it },
                        onDone = { calls.done += it },
                        onSnooze = { calls.snooze += it },
                        onShowMore = {}
                    )
                }
            }
            if (snackbar != null) SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp))
        }
    }

    private fun show(mode: AidenAppearanceMode, calls: Calls = Calls(), snackbar: SnackbarHostState? = null) {
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(mode = mode)) { InboxFixture(calls, snackbar) }
        }
    }

    @Test
    fun sectionsListInTheDesktopOrderWithTheWorkingShelfLast() {
        show(AidenAppearanceMode.LIGHT)
        for (title in listOf("Needs you", "Pinned", "Updates", "Earlier", "Working")) {
            compose.onNode(isHeading() and hasText(title)).assertIsDisplayed()
        }
        val tops = listOf("approve", "pinned", "update", "earlier", "working").map {
            compose.onNodeWithTag("inbox_row_$it").fetchSemanticsNode().boundsInRoot.top
        }
        assertEquals(tops.sorted(), tops)
        capture("inbox-light.png")
    }

    @Test
    fun rowsSayWhatTheyWaitOnAndTalkBackGetsEachSwipeAsAnAction() {
        val calls = Calls()
        show(AidenAppearanceMode.LIGHT, calls)
        val unreadRow = compose.onNodeWithTag("inbox_row_update").fetchSemanticsNode()
        val described = unreadRow.children.flatMap { listOf(it) + it.children }
            .firstNotNullOf { node -> node.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() }
        assertTrue(described, described.startsWith("Summarize the review, Aiden Agent") && described.endsWith("Unread"))

        val actions = { id: String ->
            compose.onNodeWithTag("inbox_row_$id").fetchSemanticsNode().children
                .flatMap { listOf(it) + it.children }
                .flatMap { it.config.getOrNull(SemanticsActions.CustomActions).orEmpty() }
                .map { it.label }
        }
        assertEquals(listOf("Mark read", "Done", "Snooze"), actions("update"))
        assertEquals(listOf("Done", "Snooze"), actions("earlier"))
        // Done and Snooze are never offered while a row waits on you or runs.
        assertEquals(emptyList<String>(), actions("approve"))
        assertEquals(emptyList<String>(), actions("working"))

        // A TalkBack action runs the same write as the swipe.
        compose.onNodeWithTag("inbox_row_update").fetchSemanticsNode().children
            .flatMap { listOf(it) + it.children }
            .flatMap { it.config.getOrNull(SemanticsActions.CustomActions).orEmpty() }
            .first { it.label == "Done" }.action()
        compose.waitForIdle()
        assertEquals(listOf("update"), calls.done.toList())
    }

    @Test
    fun swipingRevealsTheActionsAndTappingOneRunsIt() {
        val calls = Calls()
        show(AidenAppearanceMode.LIGHT, calls)
        compose.onNodeWithTag("inbox_row_update").performTouchInput { swipeRight() }
        compose.waitForIdle()
        compose.onNodeWithTag("inbox_mark_read_update", useUnmergedTree = true).assertIsDisplayed()
        capture("inbox-swipe-leading.png")
        compose.onNodeWithTag("inbox_mark_read_update", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals(listOf("update"), calls.markRead.toList())

        compose.onNodeWithTag("inbox_row_earlier").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithTag("inbox_done_earlier", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("inbox_snooze_earlier", useUnmergedTree = true).assertIsDisplayed()
        capture("inbox-swipe-trailing.png")
        compose.onNodeWithTag("inbox_snooze_earlier", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals(listOf("earlier"), calls.snooze.toList())
    }

    @Test
    fun darkThemeAndUndoSnackbar() {
        val snackbar = SnackbarHostState()
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(mode = AidenAppearanceMode.DARK)) {
                InboxFixture(Calls(), snackbar)
                LaunchedEffect(Unit) { snackbar.showSnackbar("Marked done", actionLabel = "Undo") }
            }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTextCount("Marked done") > 0
        }
        capture("inbox-dark-undo.png")
        compose.mainClock.autoAdvance = true
    }

    @Test
    fun workingShelfShowsTheRing() {
        compose.mainClock.autoAdvance = false
        show(AidenAppearanceMode.DARK)
        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithTag("inbox_row_working").assertIsDisplayed()
        capture("inbox-dark.png")
        compose.onNodeWithTag("inbox_row_working").captureToImage().asAndroidBitmap().let { save("inbox-working.png", it) }
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextCount(text: String): Int =
        onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Text, listOf(androidx.compose.ui.text.AnnotatedString(text))), useUnmergedTree = true)
            .fetchSemanticsNodes().size

    private fun capture(name: String) {
        save(name, compose.onNodeWithTag("inbox_fixture").captureToImage().asAndroidBitmap())
    }

    private fun save(name: String, bitmap: Bitmap) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, name)
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(file.length() > 0)
    }
}
