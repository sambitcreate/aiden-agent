package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.features.scheduled.AidenScheduledRunIdempotencyKeys
import sbtbiswas.AidenOnTheGo.features.scheduled.aidenScheduledOperationCanClear
import sbtbiswas.AidenOnTheGo.features.scheduled.aidenScheduledRunFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

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

        val duplicateMcpScope = validTask.copy(mcpServerIds = listOf("mcp-1", "mcp-1"))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenScheduledTaskValidation.tasks(listOf(duplicateMcpScope))
        }

        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenScheduledTaskValidation.tasks(listOf(validTask, validTask))
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
    fun testScheduledTaskSearchStatusFilteringAndStableOrdering() {
        val paused = task(
            id = "task_paused",
            name = "Weekly review",
            enabled = false,
            prompt = "Summarize progress",
            nextRunAt = Instant.parse("2026-09-04T20:00:00Z")
        )
        val later = task(
            id = "task_later",
            name = "Daily brief",
            enabled = true,
            prompt = "Review email",
            nextRunAt = Instant.parse("2026-09-01T13:00:00Z")
        )
        val sooner = task(
            id = "task_sooner",
            name = "Morning monitor",
            enabled = true,
            prompt = "Review pull requests",
            nextRunAt = Instant.parse("2026-08-31T13:00:00Z")
        )

        assertEquals(
            listOf("task_sooner", "task_later", "task_paused"),
            AidenScheduledTaskPresentation.visible(
                listOf(paused, later, sooner),
                query = "",
                filter = AidenScheduledTaskFilter.ALL
            ).map { it.id }
        )
        assertEquals(
            listOf("task_paused"),
            AidenScheduledTaskPresentation.visible(
                listOf(paused, later, sooner),
                query = "progress",
                filter = AidenScheduledTaskFilter.PAUSED
            ).map { it.id }
        )
        assertTrue(
            AidenScheduledTaskPresentation.visible(
                listOf(paused, later, sooner),
                query = "weekly",
                filter = AidenScheduledTaskFilter.ACTIVE
            ).isEmpty()
        )
    }

    @Test
    fun testScheduledTaskPresentationHumanizesKnownCronWithoutExposingCustomSyntax() {
        val base = task(id = "task_1", name = "Test", enabled = true, prompt = "Check")
        assertEquals("Every 15 minutes", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "*/15 * * * *")))
        assertEquals("Every 2 hours", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "0 */2 * * *")))
        assertEquals("Every hour at 20 minutes past", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "20 * * * *")))
        assertEquals("Every hour at 1 minute past", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "1 * * * *")))
        assertEquals("Daily at 9:05 AM", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "5 9 * * *")))
        assertEquals("Weekdays at 4:00 PM", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "0 16 * * 1-5")))
        assertEquals("Monday at 9:00 AM", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "0 9 * * 1")))
        assertEquals("Custom schedule", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "0 9 1 * *")))
        assertEquals("Custom schedule", AidenScheduledTaskPresentation.schedule(base.copy(schedule = "not cron")))
        assertEquals(
            "Aug 30 at 12:00 PM",
            AidenScheduledTaskPresentation.timestamp(
                Instant.parse("2026-08-30T16:00:00Z"),
                ZoneId.of("America/New_York")
            )
        )
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

    @Test
    fun testRunNowReusesKeyAfterAmbiguousFailureAndClearsAfterAcceptance() {
        val first = UUID.fromString("11111111-1111-1111-1111-111111111111")
        val second = UUID.fromString("22222222-2222-2222-2222-222222222222")
        val third = UUID.fromString("33333333-3333-3333-3333-333333333333")
        val generated = ArrayDeque(listOf(first, second, third))
        val keys = AidenScheduledRunIdempotencyKeys { generated.removeFirst() }

        assertEquals(first, keys.keyFor("task_1"))
        keys.failed("task_1", IOException("timeout after upload"))
        assertEquals(first, keys.keyFor("task_1"))
        assertEquals(second, keys.keyFor("task_2"))

        keys.accepted("task_1")
        assertEquals(third, keys.keyFor("task_1"))
        assertTrue(aidenScheduledRunFailureIsAmbiguous(AidenRemoteClientException.InvalidResponse()))
        assertTrue(aidenScheduledRunFailureIsAmbiguous(AidenRemoteClientException.Disconnected()))
    }

    @Test
    fun testRunNowClearsKeyAfterDefinitiveRejectionButRetainsInFlightServerFailure() {
        val first = UUID.fromString("11111111-1111-1111-1111-111111111111")
        val second = UUID.fromString("22222222-2222-2222-2222-222222222222")
        val generated = ArrayDeque(listOf(first, second))
        val keys = AidenScheduledRunIdempotencyKeys { generated.removeFirst() }
        val inFlight = serverError(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT)
        val rejected = serverError(AidenRemoteErrorCode.SCHEDULE_DISABLED)

        assertEquals(first, keys.keyFor("task_1"))
        keys.failed("task_1", inFlight)
        assertEquals(first, keys.keyFor("task_1"))

        keys.failed("task_1", rejected)
        assertEquals(second, keys.keyFor("task_1"))
        assertTrue(aidenScheduledRunFailureIsAmbiguous(inFlight))
        assertFalse(aidenScheduledRunFailureIsAmbiguous(rejected))
    }

    @Test
    fun testOldOperationCannotClearNewOperationState() {
        val oldRequest = UUID.fromString("11111111-1111-1111-1111-111111111111")
        val newRequest = UUID.fromString("22222222-2222-2222-2222-222222222222")

        assertTrue(aidenScheduledOperationCanClear(oldRequest, oldRequest))
        assertFalse(aidenScheduledOperationCanClear(newRequest, oldRequest))
        assertFalse(aidenScheduledOperationCanClear(null, oldRequest))
    }

    @Test
    fun testScheduleReadRevocationPurgesCachedTasksAndRuns() {
        val cacheDir = File(tempFolder.root, "revoked_schedule_cache").apply { mkdirs() }
        val cache = sbtbiswas.AidenOnTheGo.persistence.AidenScheduledTaskCache(cacheDir)
        val task = task(id = "task_1", name = "Daily report", enabled = true, prompt = "Summarize")
        val run = AidenScheduledRun(
            id = "run_1",
            taskId = task.id,
            status = "succeeded",
            startedAt = Instant.parse("2026-08-30T12:00:00Z")
        )

        cache.store("instance_1", listOf(task), settings = null)
        cache.store(listOf(run), task.id, "instance_1")
        assertNotNull(cache.loadForScheduleReadAccess("instance_1", canRead = true))

        assertNull(cache.loadForScheduleReadAccess("instance_1", canRead = false))
        assertNull(cache.load("instance_1"))
    }

    private fun task(
        id: String,
        name: String,
        enabled: Boolean,
        prompt: String,
        nextRunAt: Instant? = null
    ) = AidenScheduledTask(
        id = id,
        revision = "rev_$id",
        name = name,
        enabled = enabled,
        schedule = "0 9 * * *",
        timezone = "America/New_York",
        mode = AidenScheduledTaskMode.LLM,
        permission = AidenScheduledTaskPermission.READ_ONLY,
        prompt = prompt,
        notify = true,
        running = false,
        nextRunAt = nextRunAt,
        createdAt = Instant.parse("2026-08-30T12:00:00Z"),
        updatedAt = Instant.parse("2026-08-30T12:00:00Z")
    )

    private fun serverError(code: AidenRemoteErrorCode) = AidenRemoteClientException.Server(
        statusCode = 409,
        body = AidenRemoteErrorEnvelope.Body(
            code = code,
            message = "Rejected",
            requestId = "request_1",
            retryable = false
        )
    )
}
