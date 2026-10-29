package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJob
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobCopy
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobTransport
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobs
import sbtbiswas.AidenOnTheGo.models.AidenBackgroundJobsState
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Contract revision 48 (`chat:jobs`), read from the fixture every client shares. */
class AidenBackgroundJobsTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("backgroundJobs").jsonObject
    }

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    private fun json(response: JsonElement) =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(response.toString())

    private val start = Instant.parse("2026-10-29T09:00:00Z")

    private fun job(
        id: String,
        state: AidenBackgroundJob.State = AidenBackgroundJob.State.RUNNING,
        exitCode: Int? = null,
        endReason: String? = null,
        fromCommand: Boolean? = null,
        ports: List<Int> = emptyList()
    ) = AidenBackgroundJob(
        id = id,
        label = "Run the dev server",
        state = state,
        startedAt = start.toString(),
        endedAt = if (state == AidenBackgroundJob.State.RUNNING) null else start.plusSeconds(60).toString(),
        exitCode = exitCode,
        endReason = endReason,
        fromCommand = fromCommand,
        ports = ports
    )

    @Test
    fun readsTheChatsJobsAndStopsOneWithAnEmptyBody() = runBlocking<Unit> {
        server.enqueue(json(fixture.getValue("list")))
        server.enqueue(json(fixture.getValue("stop").jsonObject.getValue("response")))

        val list = client.backgroundJobs("chat_fixture_01")
        assertEquals(listOf(5173), list.jobs[0].ports)
        assertTrue(list.jobs[1].isFromCommand)
        assertEquals(1, list.jobs[2].exitCode)
        val read = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("GET", read.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/jobs", read.requestUrl!!.encodedPath)

        val after = client.stopBackgroundJob("chat_fixture_01", "job_1a2b3c4d")
        val stopped = after.jobs.first { it.id == "job_1a2b3c4d" }
        assertEquals(AidenBackgroundJob.State.STOPPED, stopped.state)
        assertEquals("person", stopped.endReason)
        val stop = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", stop.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/jobs/job_1a2b3c4d/stop", stop.requestUrl!!.encodedPath)
        assertEquals("{}", stop.body.readUtf8())

        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.stopBackgroundJob("chat_fixture_01", "../server") }
        }
    }

    @Test
    fun refusesWhatAPhoneCannotShow() {
        val running = fixture.getValue("list").jsonObject.getValue("jobs").jsonArray[0].jsonObject
        fun refuses(why: String, change: MutableMap<String, JsonElement>.() -> Unit) {
            val job = JsonObject(running.toMutableMap().apply(change))
            assertThrows(why, AidenRemoteClientException.InvalidResponse::class.java) {
                AidenBackgroundJobs.decode(JsonObject(mapOf("jobs" to JsonArray(listOf(job)))).toString())
            }
        }
        refuses("a running job has no end time") { put("endedAt", JsonPrimitive("2026-10-29T09:05:00.000Z")) }
        refuses("ports are TCP ports") { put("ports", JsonArray(listOf(JsonPrimitive(70_000)))) }
        refuses("a running job has no exit code") { put("exitCode", JsonPrimitive(0)) }
        refuses("no unknown fields") { put("command", JsonPrimitive("npm run dev")) }
        refuses("ids are job ids") { put("id", JsonPrimitive("job_1")) }
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            AidenBackgroundJobs.decode(JsonObject(mapOf("jobs" to JsonArray(listOf(running, running)))).toString())
        }
    }

    @Test
    fun theWordsMatchTheMac() {
        val now = start.plusSeconds(125)
        assertEquals("Running for 2m", AidenBackgroundJobCopy.status(job("job_00000001"), now))
        assertEquals("Running for 1h 5m", AidenBackgroundJobCopy.status(job("job_00000001"), start.plusSeconds(3_900)))
        assertEquals("Failed with code 1", AidenBackgroundJobCopy.status(job("job_00000001", AidenBackgroundJob.State.FAILED, exitCode = 1), now))
        assertEquals("Finished", AidenBackgroundJobCopy.status(job("job_00000001", AidenBackgroundJob.State.EXITED, exitCode = 0), now))
        assertEquals("Ended", AidenBackgroundJobCopy.status(job("job_00000001", AidenBackgroundJob.State.EXITED, fromCommand = true), now))
        assertEquals("Stopped: too much output", AidenBackgroundJobCopy.status(job("job_00000001", AidenBackgroundJob.State.STOPPED, endReason = "output-limit"), now))
        assertEquals("localhost:5173, localhost:24678 on your Mac", AidenBackgroundJobCopy.addresses(job("job_00000001", ports = listOf(5173, 24678))))
        assertNull(AidenBackgroundJobCopy.chip(0))
        assertEquals("2 in background", AidenBackgroundJobCopy.chip(2))
        assertEquals("1 background job running", AidenBackgroundJobCopy.chipDescription(1))
    }

    @Test
    fun stopEndsTheJobAndAJobTheMacNoLongerHasRereadsTheList() = runBlocking<Unit> {
        val mac = FakeJobsMac(mutableListOf(job("job_1a2b3c4d", ports = listOf(5173)), job("job_00000001", AidenBackgroundJob.State.FAILED, exitCode = 1)))
        val state = AidenBackgroundJobsState()
        state.refresh("chat-1", mac)
        assertEquals(1, state.runningCount)

        state.stop("job_1a2b3c4d", mac)
        assertEquals(0, state.runningCount)
        assertEquals(emptyList<Int>(), state.jobs.first().ports)
        assertTrue(state.stoppingJobIds.isEmpty())

        mac.jobs.clear()
        state.stop("job_00000001", mac)
        assertEquals(emptyList<AidenBackgroundJob>(), state.jobs)
        assertNull("a job that is already gone is not an error", state.errorMessage)

        state.refresh("chat-1", null)
        assertEquals(emptyList<AidenBackgroundJob>(), state.jobs)
    }

    private inner class FakeJobsMac(val jobs: MutableList<AidenBackgroundJob>) : AidenBackgroundJobTransport {
        override suspend fun backgroundJobs(chatId: String) = AidenBackgroundJobs(jobs.toList())

        override suspend fun stopBackgroundJob(chatId: String, jobId: String): AidenBackgroundJobs {
            val index = jobs.indexOfFirst { it.id == jobId }
            if (index < 0) {
                throw AidenRemoteClientException.Server(
                    404,
                    AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.NOT_FOUND, "This chat has no such background job.", "req_1", false)
                )
            }
            jobs[index] = jobs[index].copy(
                state = AidenBackgroundJob.State.STOPPED,
                endedAt = start.plusSeconds(300).toString(),
                endReason = "person",
                ports = emptyList()
            )
            return AidenBackgroundJobs(jobs.toList())
        }
    }
}
