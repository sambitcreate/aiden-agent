package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJob
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobTransport
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobs
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobsState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.time.Instant

@RunWith(AndroidJUnit4::class)
class AidenBackgroundJobsSheetUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aFailedStopStaysInViewBelowAListLongerThanTheSheet() {
        val state = AidenBackgroundJobsState()
        runBlocking {
            state.refresh("chat-1", unreachableMac)
            state.stop("job_00000000", unreachableMac)
        }

        compose.setContent {
            AidenTheme {
                AidenBackgroundJobsSheet(state = state, canStop = true, onStop = {}, onDismiss = {})
            }
        }

        compose.onNodeWithText("dev server 0").assertIsDisplayed()
        compose.onNodeWithText("Couldn't reach your Mac.").assertIsDisplayed()
        compose.onNodeWithText("These run on your Mac. Open an address in a browser there.").assertIsDisplayed()
    }

    /** Forty running jobs (the Mac's own maximum), and a Stop that cannot reach the Mac. */
    private val unreachableMac = object : AidenBackgroundJobTransport {
        private val started = Instant.parse("2026-10-31T10:00:00Z").toString()

        override suspend fun backgroundJobs(chatId: String) = AidenBackgroundJobs(
            (0 until AidenBackgroundJobs.MAX_JOBS).map { index ->
                AidenBackgroundJob(
                    id = "job_%08x".format(index),
                    label = "dev server $index",
                    state = AidenBackgroundJob.State.RUNNING,
                    startedAt = started,
                    ports = listOf(5173 + index)
                )
            }
        )

        override suspend fun stopBackgroundJob(chatId: String, jobId: String): AidenBackgroundJobs =
            throw IllegalStateException("Couldn't reach your Mac.")
    }
}
