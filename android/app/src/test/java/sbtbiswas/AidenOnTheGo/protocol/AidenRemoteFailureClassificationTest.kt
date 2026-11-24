package sbtbiswas.AidenOnTheGo.protocol

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotActionKeys
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarError
import sbtbiswas.AidenOnTheGo.features.bots.AidenDurableFailureSettlement
import sbtbiswas.AidenOnTheGo.features.bots.AidenDurablePendingMutation
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarMutationFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotMacAnswered
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotMessageFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotResumeFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.features.scheduled.aidenScheduledRunFailureIsAmbiguous
import sbtbiswas.AidenOnTheGo.models.AidenNewWorktreeRetry
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
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
}
