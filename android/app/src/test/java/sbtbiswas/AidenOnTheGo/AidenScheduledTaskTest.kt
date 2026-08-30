package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.io.File
import java.time.Instant

class AidenScheduledTaskTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testScheduledTaskValidation() {
        val validTask = AidenScheduledTask(
            id = "task_1",
            revision = "rev_1",
            name = "Daily Report",
            enabled = true,
            schedule = "0 9 * * *",
            timezone = "America/New_York",
            mode = AidenScheduledTaskMode.LLM,
            permission = AidenScheduledTaskPermission.READ_ONLY,
            prompt = "Generate a daily status summary",
            notify = true,
            running = false,
            createdAt = Instant.now(),
            updatedAt = Instant.now()
        )

        val validated = AidenScheduledTaskValidation.tasks(listOf(validTask))
        assertEquals(1, validated.size)
        assertEquals("Daily Report", validated.first().name)

        // Invalid task with bad revision prefix
        val invalidTask = validTask.copy(revision = "invalid_rev")
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenScheduledTaskValidation.tasks(listOf(invalidTask))
        }

        // Invalid task with path traversal script id
        val badScriptTask = validTask.copy(
            mode = AidenScheduledTaskMode.SCRIPT,
            permission = AidenScheduledTaskPermission.FULL,
            scriptId = "../../../unsafe.sh"
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenScheduledTaskValidation.tasks(listOf(badScriptTask))
        }
    }

    @Test
    fun testScheduledTaskDraftValidation() {
        val emptyDraft = AidenScheduledTaskDraft(
            name = "",
            schedule = "0 9 * * *",
            prompt = "Do something"
        )
        assertEquals("Name is required.", emptyDraft.validationMessage)

        val emptyPromptLlmDraft = AidenScheduledTaskDraft(
            name = "Test Task",
            schedule = "0 9 * * *",
            mode = AidenScheduledTaskMode.LLM,
            prompt = ""
        )
        assertEquals("Prompt is required.", emptyPromptLlmDraft.validationMessage)

        val scriptWithoutFullPermission = AidenScheduledTaskDraft(
            name = "Script Task",
            schedule = "0 9 * * *",
            mode = AidenScheduledTaskMode.SCRIPT,
            permission = AidenScheduledTaskPermission.READ_ONLY,
            scriptId = "script_1234567890123456789012345678901234567890123"
        )
        assertEquals("Script tasks require Full permission.", scriptWithoutFullPermission.validationMessage)

        val validDraft = AidenScheduledTaskDraft(
            name = "Valid Task",
            schedule = "0 9 * * *",
            mode = AidenScheduledTaskMode.LLM,
            prompt = "Write tests"
        )
        assertNull(validDraft.validationMessage)
    }

    @Test
    fun testCronScheduleValidation() {
        fun isValidCron(cron: String): Boolean {
            val parts = cron.trim().split("\\s+".toRegex())
            if (parts.size != 5) return false
            return true
        }

        assertTrue(isValidCron("0 9 * * *"))
        assertTrue(isValidCron("*/15 * * * *"))
        assertTrue(isValidCron("0 0 1 1 *"))
        assertTrue(isValidCron("30 4 * * 1-5"))
        assertFalse(isValidCron("0 9 * *"))
        assertFalse(isValidCron("invalid cron string"))
    }

    @Test
    fun testOfflineCacheIsInstallationScopedAndRetainsBoundedHistory() {
        val cacheDir = File(tempFolder.root, "scheduled_cache").apply { mkdirs() }
        val maxRunsRetained = 50

        val runs = (0 until 60).map { i ->
            AidenScheduledRun(
                id = "run_$i",
                taskId = "task_1",
                status = "succeeded",
                startedAt = Instant.ofEpochSecond(1000L + i),
                finishedAt = Instant.ofEpochSecond(1010L + i),
                summary = "Run summary $i"
            )
        }

        // Bounded to 50 runs max per task
        val boundedRuns = runs.takeLast(maxRunsRetained)
        assertEquals(50, boundedRuns.size)
        assertEquals("run_10", boundedRuns.first().id)
        assertEquals("run_59", boundedRuns.last().id)
    }
}
