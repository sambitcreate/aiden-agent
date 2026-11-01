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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
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
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceMode
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageChange
import sbtbiswas.AidenOnTheGo.models.AidenChatTriageResult
import sbtbiswas.AidenOnTheGo.models.AidenInboxProjection
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSnackbar
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

    /** What the host can do; either can arrive after the list does. */
    private class Host {
        var supportsReadState by mutableStateOf(true)
        var supportsTriage by mutableStateOf(true)
        val writes = mutableStateListOf<AidenChatTriageChange>()
        var revision = 0
    }

    @Composable
    private fun InboxFixture(
        calls: Calls,
        snackbar: SnackbarHostState? = null,
        host: Host = remember { Host() }
    ) {
        val rows = remember { mutableStateMapOf<String, AidenChatSummary>().apply { fixture.forEach { put(it.id, it) } } }
        var notice by remember { mutableStateOf<AidenInboxNotice?>(null) }
        val scope = rememberCoroutineScope()
        val triage = remember {
            AidenInboxTriage(
                row = { rows[it] },
                publish = { rows[it.id] = it },
                isCurrent = { true },
                writeTriage = { id, change, _, _ ->
                    host.writes += change
                    val before = rows.getValue(id)
                    val at = Instant.now()
                    AidenChatTriageResult(
                        chatId = id,
                        revision = ++host.revision,
                        updatedAt = at,
                        pinnedAt = change.pinned?.let { if (it) at else null } ?: before.pinnedAt,
                        doneAt = change.done?.let { if (it) at else null } ?: before.doneAt,
                        snoozedUntil = when (val snooze = change.snooze) {
                            is AidenChatTriageChange.Snooze.Until -> snooze.at
                            AidenChatTriageChange.Snooze.Wake -> null
                            null -> before.snoozedUntil
                        }
                    )
                },
                writeRead = {},
                reload = {}
            )
        }
        fun write(id: String, change: AidenChatTriageChange, offersUndo: Boolean = true) {
            scope.launch {
                triage.setTriage(id, change, readsFailures = host.supportsReadState, offersUndo = offersUndo)
                    ?.let { notice = it }
            }
        }
        val projection = AidenInboxProjection.make(fixture.mapNotNull { rows[it.id] }, names, openChatId = null, now = now)
        val offers = AidenInboxRowOffers(supportsReadState = host.supportsReadState, supportsTriage = host.supportsTriage)
        val swipe = remember { AidenInboxSwipeState() }
        val palette = AidenTheme.palette
        if (snackbar != null) {
            AidenInboxNoticeEffect(
                notice = notice,
                snackbarHostState = snackbar,
                onUndo = { id, undo -> write(id, undo, offersUndo = false) },
                onDismissed = { id -> if (notice?.id == id) notice = null }
            )
        }
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
                        offers = offers,
                        swipe = swipe,
                        onOpen = { calls.opened += it },
                        onMarkRead = { calls.markRead += it },
                        onDone = { calls.done += it; write(it, AidenChatTriageChange.done(true)) },
                        onSnooze = { calls.snooze += it },
                        onShowMore = {}
                    )
                }
            }
            if (snackbar != null) {
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp)) { AidenSnackbar(it) }
            }
        }
    }

    private fun show(mode: AidenAppearanceMode, calls: Calls = Calls(), snackbar: SnackbarHostState? = null, host: Host = Host()) {
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(mode = mode)) { InboxFixture(calls, snackbar, host) }
        }
    }

    private fun actions(id: String): List<String> =
        compose.onNodeWithTag("inbox_row_$id").fetchSemanticsNode().children
            .flatMap { listOf(it) + it.children }
            .flatMap { it.config.getOrNull(SemanticsActions.CustomActions).orEmpty() }
            .map { it.label }

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

        assertEquals(listOf("Mark read", "Done", "Snooze"), actions("update"))
        assertEquals(listOf("Done", "Snooze"), actions("earlier"))
        // Done and Snooze are never offered while a row waits on you or runs.
        assertEquals(emptyList<String>(), actions("approve"))
        assertEquals(emptyList<String>(), actions("working"))
        // The unseen failure is read along with Done or Snooze.
        assertEquals(listOf("Mark read", "Done", "Snooze"), actions("failed"))

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
    fun actionsFollowWhatTheHostCanDoEvenWhenItArrivesLate() {
        val host = Host().apply { supportsReadState = false; supportsTriage = false }
        show(AidenAppearanceMode.LIGHT, host = host)
        assertEquals(emptyList<String>(), actions("update"))
        assertEquals(emptyList<String>(), actions("earlier"))

        // chat-triage-v1 arrives after the list: Done and Snooze appear,
        // but not on an unseen failure the host cannot mark read.
        host.supportsTriage = true
        compose.waitForIdle()
        assertEquals(listOf("Done", "Snooze"), actions("update"))
        assertEquals(listOf("Done", "Snooze"), actions("earlier"))
        assertEquals(emptyList<String>(), actions("failed"))

        host.supportsReadState = true
        compose.waitForIdle()
        assertEquals(listOf("Mark read", "Done", "Snooze"), actions("update"))
        assertEquals(listOf("Mark read", "Done", "Snooze"), actions("failed"))
    }

    @Test
    fun doneShowsTheNoticeAndUndoPutsTheRowBack() {
        val snackbar = SnackbarHostState()
        val host = Host()
        show(AidenAppearanceMode.DARK, snackbar = snackbar, host = host)
        compose.onNodeWithTag("inbox_row_earlier").assertIsDisplayed()

        compose.onNodeWithTag("inbox_row_earlier").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithTag("inbox_done_earlier", useUnmergedTree = true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Marked done").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithTag("inbox_row_earlier").assertCountEquals(0)
        assertEquals(listOf(AidenChatTriageChange.done(true)), host.writes.toList())
        capture("inbox-dark-undo.png")

        compose.onNodeWithText("Undo").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("inbox_row_earlier").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf(AidenChatTriageChange.done(true), AidenChatTriageChange.done(false)), host.writes.toList())
        // Undo offers no Undo of its own.
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Marked done").fetchSemanticsNodes().isEmpty() }
        compose.onAllNodesWithText("Undo").assertCountEquals(0)
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
