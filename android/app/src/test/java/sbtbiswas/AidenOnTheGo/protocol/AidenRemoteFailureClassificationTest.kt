package sbtbiswas.AidenOnTheGo.protocol

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotActionKeys
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarError
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotResumeController
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotResumeTransport
import sbtbiswas.AidenOnTheGo.features.bots.AidenDurableFailureSettlement
import sbtbiswas.AidenOnTheGo.features.bots.AidenDurablePendingMutation
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarMutationFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotMacAnswered
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotMessageFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotResumeFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.features.scheduled.AidenScheduledRunIdempotencyKeys
import sbtbiswas.AidenOnTheGo.features.scheduled.aidenScheduledRunFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.models.AidenBotResumeRequest
import sbtbiswas.AidenOnTheGo.models.AidenBotResumeStatus
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionState
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionStateView
import sbtbiswas.AidenOnTheGo.models.AidenNewWorktreeRetry
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournalStore
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.UUID

class AidenRemoteFailureClassificationTest {
    private fun server(status: Int, code: AidenRemoteErrorCode, retryable: Boolean = false) =
        AidenRemoteClientException.Server(
            statusCode = status,
            body = AidenRemoteErrorEnvelope.Body(code, "Server response", "req_test", retryable)
        )

    @Test
    fun inFlight409AndCancellationAreAmbiguousAcrossEveryPolicyAndWrapper() {
        val inFlight = server(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT, retryable = false)
        val inFlightRetryable = server(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT, retryable = true)
        val cancelled = CancellationException("cancelled mid-flight")
        val lost = IOException("socket closed")
        val disconnected = AidenRemoteClientException.Disconnected()

        for (error in listOf(inFlight, inFlightRetryable, cancelled, lost, disconnected)) {
            for (policy in AidenRemoteFailurePolicy.entries) {
                assertTrue(
                    "$error must be ambiguous under $policy",
                    AidenRemoteFailureClassification.isAmbiguous(error, policy)
                )
            }
            assertTrue("Resume keeps pending on $error", aidenBotResumeFailureIsAmbiguous(error))
            assertTrue("Bot message keeps key on $error", aidenBotMessageFailureIsAmbiguous(error))
            assertFalse("Bot action keys retain on $error", aidenBotMacAnswered(error))
            assertTrue("Scheduled run keeps key on $error", aidenScheduledRunFailureIsAmbiguous(error))
            assertTrue("Chat fork keeps key on $error", AidenChatForkErrors.isOutcomeUnknown(error))
            assertFalse("New worktree keeps key on $error", AidenNewWorktreeRetry.spendsKey(error))
            assertTrue("Avatar mutation is ambiguous on $error", aidenBotAvatarMutationFailureIsAmbiguous(error))
        }
    }

    @Test
    fun preSendLocalErrorsAreNeverAmbiguousAcrossPolicies() {
        val localErrors = listOf(
            AidenRemoteClientException.MissingCredential,
            AidenRemoteClientException.MissingTrustConfiguration,
            AidenRemoteClientException.InstallationChanged,
            AidenRemoteClientException.InvalidEndpoint
        )
        for (error in localErrors) {
            for (policy in AidenRemoteFailurePolicy.entries) {
                assertFalse(
                    "$error never left the device under $policy",
                    AidenRemoteFailureClassification.isAmbiguous(error, policy)
                )
            }
        }
        assertFalse(aidenBotAvatarMutationFailureIsAmbiguous(AidenBotGeneratedAvatarError.Unavailable))
    }

    @Test
    fun strictBeforeEffectAllowlistDistinguishesUnknownConflictsFromProvenRefusals() {
        val unknownErrors = listOf(
            server(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT),
            server(409, AidenRemoteErrorCode.INTERNAL_ERROR),
            server(409, AidenRemoteErrorCode("new_resume_recovery")),
            server(400, AidenRemoteErrorCode("outcome_unknown")),
            server(500, AidenRemoteErrorCode.INTERNAL_ERROR),
            server(503, AidenRemoteErrorCode.INTERNAL_ERROR),
            server(408, AidenRemoteErrorCode.INVALID_REQUEST),
            server(429, AidenRemoteErrorCode.RATE_LIMITED),
            AidenRemoteClientException.UnexpectedStatus(400),
            AidenRemoteClientException.UnexpectedStatus(409),
            AidenRemoteClientException.InvalidResponse()
        )
        for (error in unknownErrors) {
            assertTrue(
                "$error must stay ambiguous under BEFORE_EFFECT_REFUSAL",
                AidenRemoteFailureClassification.isAmbiguous(error, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL)
            )
            assertTrue(
                "$error must stay ambiguous under BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT",
                AidenRemoteFailureClassification.isAmbiguous(
                    error,
                    AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT
                )
            )
        }

        val revisionConflict = server(409, AidenRemoteErrorCode.REVISION_CONFLICT)
        assertTrue(
            "Resume does not use revision_conflict as a before-effect refusal",
            AidenRemoteFailureClassification.isAmbiguous(revisionConflict, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL)
        )
        assertFalse(
            "Watches and Avatar reject stale If-Match before effect",
            AidenRemoteFailureClassification.isAmbiguous(
                revisionConflict,
                AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT
            )
        )

        val definiteRefusals = listOf(
            server(400, AidenRemoteErrorCode.INVALID_REQUEST),
            server(401, AidenRemoteErrorCode.AUTHENTICATION_REQUIRED),
            server(403, AidenRemoteErrorCode.CAPABILITY_DENIED),
            server(404, AidenRemoteErrorCode.NOT_FOUND),
            server(409, AidenRemoteErrorCode.OPERATION_STALE),
            server(409, AidenRemoteErrorCode.BOT_PAUSED),
            server(409, AidenRemoteErrorCode.IDEMPOTENCY_CONFLICT),
            server(413, AidenRemoteErrorCode.PAYLOAD_TOO_LARGE),
            server(422, AidenRemoteErrorCode.INVALID_REQUEST)
        )
        for (error in definiteRefusals) {
            assertFalse(
                "$error is a proven before-effect refusal",
                AidenRemoteFailureClassification.isAmbiguous(error, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL)
            )
            assertFalse(
                "$error is a proven before-effect refusal with revision conflict enabled",
                AidenRemoteFailureClassification.isAmbiguous(
                    error,
                    AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT
                )
            )
        }
    }

    @Test
    fun cachedRejectionLedgerMatchesSharedBotOutboxFixtureAndPreservesStrictReplayContract() {
        val relative = "protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json"
        val root = generateSequence(File(System.getProperty("user.dir")!!).absoluteFile) { it.parentFile }
            .first { File(it, relative).isFile }
        val rows = Json.parseToJsonElement(File(root, relative).readText())
            .jsonObject.getValue("classification").jsonArray
        for (element in rows) {
            val row = element.jsonObject
            val error = server(
                row.getValue("status").jsonPrimitive.int,
                AidenRemoteErrorCode(row.getValue("code").jsonPrimitive.content)
            )
            val expected = row.getValue("ambiguous").jsonPrimitive.boolean
            val name = row.getValue("name").jsonPrimitive.content
            assertEquals(
                name,
                expected,
                AidenRemoteFailureClassification.isAmbiguous(error, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER)
            )
            assertEquals(name, expected, aidenScheduledRunFailureIsAmbiguous(error))
        }

        // Strict cached-rejection endpoints spend the key on 500 internal_error as well.
        val server500 = server(500, AidenRemoteErrorCode.INTERNAL_ERROR)
        assertFalse(AidenChatForkErrors.isOutcomeUnknown(server500))
        assertTrue(AidenNewWorktreeRetry.spendsKey(server500))
        assertTrue(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientException.UnexpectedStatus(502)))
        assertTrue(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientException.InvalidResponse()))
        assertFalse(AidenNewWorktreeRetry.spendsKey(SocketTimeoutException("timeout")))
        assertTrue(AidenChatForkErrors.isOutcomeUnknown(AidenRemoteClientException.InvalidResponse()))
    }

    @Test
    fun botActionKeysRetainKeyOnInFlight409And5xxAndClearOnDefiniteRefusal() {
        val keys = ArrayDeque(
            listOf(
                UUID.fromString("11111111-1111-4111-8111-111111111111"),
                UUID.fromString("22222222-2222-4222-8222-222222222222")
            )
        )
        val store = AidenBotActionKeys { keys.removeFirst() }
        val first = store.key("stop")
        store.failed("stop", server(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT))
        assertEquals(first, store.key("stop"))
        store.failed("stop", server(503, AidenRemoteErrorCode.INTERNAL_ERROR))
        assertEquals(first, store.key("stop"))
        store.failed("stop", server(429, AidenRemoteErrorCode.RATE_LIMITED))
        assertEquals(first, store.key("stop"))
        store.failed("stop", server(403, AidenRemoteErrorCode.CAPABILITY_DENIED))
        assertEquals(UUID.fromString("22222222-2222-4222-8222-222222222222"), store.key("stop"))
    }

    @Test
    fun durablePendingMutationWindowAndPreviouslyUnknownStickiness() {
        val start = 10_000L
        assertTrue(AidenDurablePendingMutation.isRetryAllowed(start, start))
        assertTrue(AidenDurablePendingMutation.isRetryAllowed(start, start + AidenDurablePendingMutation.RETRY_WINDOW_MS - 1))
        assertFalse(AidenDurablePendingMutation.isRetryAllowed(start, start + AidenDurablePendingMutation.RETRY_WINDOW_MS))
        assertFalse("clock rollback fails closed", AidenDurablePendingMutation.isRetryAllowed(start, start - 1))
        assertTrue("stop exemption overrides expiry", AidenDurablePendingMutation.isRetryAllowed(start, start + AidenDurablePendingMutation.RETRY_WINDOW_MS * 3, exempt = true))

        val definite = server(403, AidenRemoteErrorCode.CAPABILITY_DENIED)
        assertEquals(
            AidenDurableFailureSettlement.CLEAR_DEFINITE,
            AidenDurablePendingMutation.settleFailure(definite, previouslyUnknown = false)
        )
        assertEquals(
            AidenDurableFailureSettlement.RETAIN_UNCERTAIN,
            AidenDurablePendingMutation.settleFailure(definite, previouslyUnknown = true)
        )
        assertEquals(
            AidenDurableFailureSettlement.RETAIN_UNCERTAIN,
            AidenDurablePendingMutation.settleFailure(
                server(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT),
                previouslyUnknown = false
            )
        )
    }

    @Test
    fun parseErrorDistinguishesMalformed409FromDecoded409InternalErrorAndRetainsKeys() {
        val malformed409Bodies = listOf(
            // Real 409 idempotency_in_flight that fails duplicate-key validation
            """{"error":{"code":"idempotency_in_flight","code":"idempotency_in_flight","message":"Still running","requestId":"req_dup","retryable":true}}""",
            // Truncated JSON
            "{\"error\":{\"code\":\"idempotency_in_flight\"",
            // Missing required envelope fields
            """{"error":{"code":"idempotency_in_flight"}}""",
            // Plain text proxy/server error
            "Conflict",
            // Empty body
            ""
        )

        for (raw in malformed409Bodies) {
            val parsed = AidenRemoteClient.parseError(409, raw.toByteArray(Charsets.UTF_8))
            assertEquals(409, parsed.statusCode)
            assertFalse("malformed body must not be marked as decoded envelope: $raw", parsed.isDecodedEnvelope)

            for (policy in AidenRemoteFailurePolicy.entries) {
                assertTrue(
                    "malformed 409 ($raw) must remain ambiguous under $policy",
                    AidenRemoteFailureClassification.isAmbiguous(parsed, policy)
                )
            }
            assertTrue(aidenBotMessageFailureIsAmbiguous(parsed))
            assertFalse(aidenBotMacAnswered(parsed))
            assertTrue(aidenBotResumeFailureIsAmbiguous(parsed))
            assertTrue(aidenBotAvatarMutationFailureIsAmbiguous(parsed))
            assertTrue(aidenScheduledRunFailureIsAmbiguous(parsed))
            assertTrue(AidenChatForkErrors.isOutcomeUnknown(parsed))
            assertFalse("new-worktree must keep key on malformed 409 ($raw)", AidenNewWorktreeRetry.spendsKey(parsed))

            val botKey1 = UUID.fromString("11111111-1111-4111-8111-111111111111")
            val botKey2 = UUID.fromString("22222222-2222-4222-8222-222222222222")
            val botKeys = AidenBotActionKeys(ArrayDeque(listOf(botKey1, botKey2))::removeFirst)
            assertEquals(botKey1, botKeys.key("stop"))
            botKeys.failed("stop", parsed)
            assertEquals("Bot action key must be retained on malformed 409 ($raw)", botKey1, botKeys.key("stop"))

            val runKey1 = UUID.fromString("33333333-3333-4333-8333-333333333333")
            val runKey2 = UUID.fromString("44444444-4444-4444-8444-444444444444")
            val runKeys = AidenScheduledRunIdempotencyKeys(ArrayDeque(listOf(runKey1, runKey2))::removeFirst)
            assertEquals(runKey1, runKeys.keyFor("task_1"))
            runKeys.failed("task_1", parsed)
            assertEquals("Scheduled run key must be retained on malformed 409 ($raw)", runKey1, runKeys.keyFor("task_1"))
        }

        // Malformed non-409 envelopes also retain keys under BEFORE_EFFECT_REFUSAL*, CACHED_REJECTION_LEDGER, and fork.
        val malformed400 = AidenRemoteClient.parseError(400, "not json".toByteArray(Charsets.UTF_8))
        assertFalse(malformed400.isDecodedEnvelope)
        assertTrue(AidenRemoteFailureClassification.isAmbiguous(malformed400, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL))
        assertTrue(AidenRemoteFailureClassification.isAmbiguous(malformed400, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL_WITH_REVISION_CONFLICT))
        assertTrue(AidenRemoteFailureClassification.isAmbiguous(malformed400, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER))
        assertTrue(AidenRemoteFailureClassification.isAmbiguous(malformed400, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER_STRICT))
        assertTrue(aidenBotMessageFailureIsAmbiguous(malformed400))
        assertFalse(aidenBotMacAnswered(malformed400))
        assertTrue(aidenScheduledRunFailureIsAmbiguous(malformed400))
        assertTrue(AidenChatForkErrors.isOutcomeUnknown(malformed400))

        // Contrast: a genuinely decoded structured 409 internal_error settles the key in cached-rejection ledger policies.
        val decoded409Internal = AidenRemoteClient.parseError(
            409,
            """{"error":{"code":"internal_error","message":"Settled rejection","requestId":"req_409","retryable":false}}"""
                .toByteArray(Charsets.UTF_8)
        )
        assertTrue(decoded409Internal.isDecodedEnvelope)
        assertEquals(AidenRemoteErrorCode.INTERNAL_ERROR, decoded409Internal.body.code)
        assertFalse(AidenRemoteFailureClassification.isAmbiguous(decoded409Internal, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER))
        assertFalse(AidenRemoteFailureClassification.isAmbiguous(decoded409Internal, AidenRemoteFailurePolicy.CACHED_REJECTION_LEDGER_STRICT))
        assertFalse(aidenBotMessageFailureIsAmbiguous(decoded409Internal))
        assertTrue(aidenBotMacAnswered(decoded409Internal))
        assertFalse(aidenScheduledRunFailureIsAmbiguous(decoded409Internal))
        assertFalse(AidenChatForkErrors.isOutcomeUnknown(decoded409Internal))
        assertTrue(AidenNewWorktreeRetry.spendsKey(decoded409Internal))
        assertTrue(AidenRemoteFailureClassification.isAmbiguous(decoded409Internal, AidenRemoteFailurePolicy.BEFORE_EFFECT_REFUSAL))

        // Contrast: a genuinely decoded 409 idempotency_in_flight keeps the key everywhere.
        val decoded409InFlight = AidenRemoteClient.parseError(
            409,
            """{"error":{"code":"idempotency_in_flight","message":"Still running","requestId":"req_inflight","retryable":true}}"""
                .toByteArray(Charsets.UTF_8)
        )
        assertTrue(decoded409InFlight.isDecodedEnvelope)
        assertEquals(AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT, decoded409InFlight.body.code)
        for (policy in AidenRemoteFailurePolicy.entries) {
            assertTrue(AidenRemoteFailureClassification.isAmbiguous(decoded409InFlight, policy))
        }
        assertFalse(AidenNewWorktreeRetry.spendsKey(decoded409InFlight))
    }

    @Test
    fun malformed409OverHttpRetainsIdempotencyKeyAcrossScheduledRunAndBotControllers() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val client = AidenRemoteClient(
                endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
                credential = "test-credential",
                customOkHttpClient = OkHttpClient.Builder().build()
            )

            // 1. Scheduled task run-now: malformed 409 retains Idempotency-Key across retry; decoded 409 internal_error clears it.
            val runKey1 = UUID.fromString("11111111-1111-4111-8111-111111111111")
            val runKey2 = UUID.fromString("22222222-2222-4222-8222-222222222222")
            val runKey3 = UUID.fromString("33333333-3333-4333-8333-333333333333")
            val scheduledKeys = AidenScheduledRunIdempotencyKeys(ArrayDeque(listOf(runKey1, runKey2, runKey3))::removeFirst)

            server.enqueue(
                MockResponse()
                    .setResponseCode(409)
                    .setBody("""{"error":{"code":"idempotency_in_flight","code":"idempotency_in_flight","message":"In flight","requestId":"req_1","retryable":true}}""")
            )
            server.enqueue(
                MockResponse()
                    .setResponseCode(202)
                    .setBody("""{"taskId":"task_1","runId":"run_1","status":"queued","acceptedAt":"2026-11-24T05:00:00Z"}""")
            )

            val firstRunError = try {
                client.runScheduledTask("task_1", "rev_1", scheduledKeys.keyFor("task_1"))
                fail("Expected HTTP 409 to throw")
                throw AssertionError()
            } catch (error: AidenRemoteClientException.Server) {
                error
            }
            assertFalse(firstRunError.isDecodedEnvelope)
            scheduledKeys.failed("task_1", firstRunError)
            assertEquals(runKey1, scheduledKeys.keyFor("task_1"))

            client.runScheduledTask("task_1", "rev_1", scheduledKeys.keyFor("task_1"))
            scheduledKeys.accepted("task_1")

            val req1 = server.takeRequest()
            val req2 = server.takeRequest()
            assertEquals(runKey1.toString(), req1.getHeader("Idempotency-Key"))
            assertEquals(runKey1.toString(), req2.getHeader("Idempotency-Key"))

            server.enqueue(
                MockResponse()
                    .setResponseCode(409)
                    .setBody("""{"error":{"code":"internal_error","message":"Settled rejection","requestId":"req_settled","retryable":false}}""")
            )
            val settledRunError = try {
                client.runScheduledTask("task_2", "rev_1", scheduledKeys.keyFor("task_2"))
                fail("Expected HTTP 409 to throw")
                throw AssertionError()
            } catch (error: AidenRemoteClientException.Server) {
                error
            }
            assertTrue(settledRunError.isDecodedEnvelope)
            scheduledKeys.failed("task_2", settledRunError)
            assertEquals(runKey3, scheduledKeys.keyFor("task_2"))
            assertNotEquals(runKey2, scheduledKeys.keyFor("task_2"))
            server.takeRequest()

            // 2. Bot action keys over HTTP: truncated 409 retains the Idempotency-Key for stopBotSession.
            val stopKey1 = UUID.fromString("55555555-5555-4555-8555-555555555555")
            val stopKey2 = UUID.fromString("66666666-6666-4666-8666-666666666666")
            val botKeys = AidenBotActionKeys(ArrayDeque(listOf(stopKey1, stopKey2))::removeFirst)

            server.enqueue(
                MockResponse()
                    .setResponseCode(409)
                    .setBody("{\"error\":{\"code\":\"idempotency_in_flight\"")
            )
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setBody("""{"state":"idle","interrupted":false}""")
            )

            val stopError = try {
                client.stopBotSession("bot-1", botKeys.key("stop"))
                fail("Expected HTTP 409 to throw")
                throw AssertionError()
            } catch (error: AidenRemoteClientException.Server) {
                error
            }
            assertFalse(stopError.isDecodedEnvelope)
            botKeys.failed("stop", stopError)
            assertEquals(stopKey1, botKeys.key("stop"))

            val stopResult = client.stopBotSession("bot-1", botKeys.key("stop"))
            assertEquals(AidenBotSessionState.IDLE, stopResult.state)
            val stopReq1 = server.takeRequest()
            val stopReq2 = server.takeRequest()
            assertEquals(stopKey1.toString(), stopReq1.getHeader("Idempotency-Key"))
            assertEquals(stopKey1.toString(), stopReq2.getHeader("Idempotency-Key"))

            // 3. Bot resume controller backed by real AidenRemoteClient: malformed 409 retains pending key and replays it.
            val resumeKey = UUID.fromString("77777777-7777-4777-8777-777777777777")
            val journal = AidenBotWatchJournalStore(InMemoryAidenSecureStore(), "bot-routine-controls", 1088)
                .journal("host", "phone", Instant.EPOCH, "bot-1|resume") { true }
            val resumeTransport = object : AidenBotResumeTransport {
                override suspend fun status(): AidenBotResumeStatus = AidenBotResumeStatus(false)
                override suspend fun resume(key: UUID, request: AidenBotResumeRequest): AidenBotSessionStateView =
                    client.resumeBotSession("bot-1", key, request)
            }
            val resumeController = AidenBotResumeController(
                transport = resumeTransport,
                mayResume = { true },
                supportsPreflight = { true },
                version = { "v1" },
                journal = journal,
                uuid = { resumeKey },
                now = { 1_000L }
            )

            server.enqueue(MockResponse().setResponseCode(409).setBody("Conflict"))
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"state":"running","interrupted":false}"""))

            assertNull(resumeController.request())
            assertNotNull("malformed 409 must retain pending resume attempt", resumeController.state.value.pending)
            val resumed = resumeController.request()
            assertNotNull(resumed)
            assertEquals(AidenBotSessionState.RUNNING, resumed!!.state)
            assertNull(resumeController.state.value.pending)

            val resumeReq1 = server.takeRequest()
            val resumeReq2 = server.takeRequest()
            assertEquals(resumeKey.toString(), resumeReq1.getHeader("Idempotency-Key"))
            assertEquals(resumeKey.toString(), resumeReq2.getHeader("Idempotency-Key"))
        } finally {
            server.shutdown()
        }
    }
}
