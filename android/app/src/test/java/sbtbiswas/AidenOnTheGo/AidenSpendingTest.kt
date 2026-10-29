package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenSpending
import sbtbiswas.AidenOnTheGo.models.AidenSpendingCopy
import sbtbiswas.AidenOnTheGo.models.AidenSpendingNoticeState
import sbtbiswas.AidenOnTheGo.models.AidenSpendingOwner
import sbtbiswas.AidenOnTheGo.models.AidenSpendingStatus
import sbtbiswas.AidenOnTheGo.models.AidenSpendingTransport
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.util.concurrent.TimeUnit

/** Contract revision 46 (`spending-limits-v1`), read from the fixture every client shares. */
class AidenSpendingTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject.getValue("spending").jsonObject
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

    private fun json(response: kotlinx.serialization.json.JsonElement) =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(response.toString())

    @Test
    fun readsTheStatusAndAllowsMoreWithTheRevisionAndAnEmptyBody() = runBlocking<Unit> {
        server.enqueue(json(fixture.getValue("chatReached")))
        server.enqueue(json(fixture.getValue("chatAllowMore").jsonObject.getValue("response")))
        server.enqueue(json(fixture.getValue("bot")))

        val reached = requireNotNull(client.spending(AidenSpendingOwner.Chat("chat_fixture_01")).spending)
        assertEquals(AidenSpending.State.REACHED, reached.state)
        assertEquals(5.37, reached.spentUsd, 0.0)
        val read = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("GET", read.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/spending", read.requestUrl!!.encodedPath)

        val after = requireNotNull(client.allowMoreSpending(AidenSpendingOwner.Chat("chat_fixture_01"), reached.revision).spending)
        assertEquals(AidenSpending.State.UNDER, after.state)
        assertEquals(10.0, after.allowedUsd, 0.0)
        val allow = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", allow.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/spending/allow-more", allow.requestUrl!!.encodedPath)
        assertEquals("sp_fixture_chat_1", allow.getHeader("If-Match"))
        assertEquals("{}", allow.body.readUtf8())

        val month = requireNotNull(client.spending(AidenSpendingOwner.Bot("bot_fixture_01")).spending)
        assertEquals(AidenSpending.Period.MONTH, month.period)
        assertNotNull(month.periodEnd)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/spending", server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.encodedPath)
    }

    @Test
    fun noLimitIsNullAndABadStatusIsRefused() = runBlocking<Unit> {
        server.enqueue(json(fixture.getValue("none")))
        assertNull(client.spending(AidenSpendingOwner.Chat("chat-1")).spending)

        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody("{}"))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.spending(AidenSpendingOwner.Chat("chat-1")) }
        }
        val below = fixture.getValue("chat").toString().replace("\"allowedUsd\":5", "\"allowedUsd\":1")
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(below))
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.spending(AidenSpendingOwner.Chat("chat-1")) }
        }
    }

    @Test
    fun theNoticeSaysWhatTheMacSays() {
        fun spending(state: AidenSpending.State, period: AidenSpending.Period = AidenSpending.Period.CHAT, spent: Double = 4.1) =
            AidenSpending(
                period = period,
                state = state,
                limitUsd = 5.0,
                allowedUsd = 5.0,
                spentUsd = spent,
                allowMoreUsd = 5.0,
                periodStart = if (period == AidenSpending.Period.MONTH) "2026-10-01T00:00:00.000Z" else null,
                periodEnd = if (period == AidenSpending.Period.MONTH) "2026-11-01T00:00:00.000Z" else null,
                revision = "sp_1"
            )
        assertNull(AidenSpendingCopy.notice(spending(AidenSpending.State.UNDER), null))
        assertEquals(
            "This chat has used $4.10 of its $5.00 limit.",
            AidenSpendingCopy.notice(spending(AidenSpending.State.NEARING), null)?.title
        )
        val reached = AidenSpendingCopy.notice(spending(AidenSpending.State.REACHED, AidenSpending.Period.MONTH, 5.37), "Ada")
        assertEquals("Ada reached its $5.00 spending limit this month.", reached?.title)
        assertEquals("It has spent $5.37. Allow $5.00 more to keep going, or change the limit on your Mac.", reached?.body)
        assertEquals("Allow $5.00 more", reached?.allowMore)
        assertEquals("$1,250.00", AidenSpendingCopy.usd(1_250.0))
        assertEquals("less than $0.01", AidenSpendingCopy.usd(0.004))
    }

    @Test
    fun aTapAnotherDeviceAlreadyAnsweredRereadsInsteadOfAddingTwice() = runBlocking<Unit> {
        val mac = FakeSpendingMac(
            AidenSpending(AidenSpending.Period.CHAT, AidenSpending.State.REACHED, 5.0, 5.0, 5.37, 5.0, revision = "sp_1")
        )
        val state = AidenSpendingNoticeState()
        state.refresh(AidenSpendingOwner.Chat("chat-1"), mac)
        assertEquals(AidenSpending.State.REACHED, state.spending?.state)

        mac.allow()
        state.allowMore(mac)
        assertEquals("the crossed tap added nothing", 1, mac.allowances)
        assertEquals(AidenSpending.State.UNDER, state.spending?.state)
        assertEquals(10.0, state.spending!!.allowedUsd, 0.0)
        assertNull(state.errorMessage)

        val unwired = AidenSpendingNoticeState()
        unwired.refresh(AidenSpendingOwner.Bot("ada"), null)
        assertNull(unwired.spending)
    }

    private class FakeSpendingMac(private var current: AidenSpending) : AidenSpendingTransport {
        var allowances = 0
            private set

        fun allow() {
            allowances += 1
            current = current.copy(state = AidenSpending.State.UNDER, allowedUsd = current.allowedUsd + current.allowMoreUsd, revision = "sp_${allowances + 1}")
        }

        override suspend fun spending(owner: AidenSpendingOwner) = AidenSpendingStatus(current)

        override suspend fun allowMoreSpending(owner: AidenSpendingOwner, revision: String): AidenSpendingStatus {
            if (revision != current.revision) {
                throw AidenRemoteClientException.Server(
                    409,
                    AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.REVISION_CONFLICT, "The spending limit changed.", "req_1", false)
                )
            }
            allow()
            return AidenSpendingStatus(current)
        }
    }
}
