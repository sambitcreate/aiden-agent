package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenRunInputPresentation
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputMode
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputQueue
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputRejectionReason
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputResult
import sbtbiswas.AidenOnTheGo.models.AidenStreamInputStatus
import java.util.UUID

/** Remote Slice 2 busy-composer rules (iOS parity: AidenChatTests run-input
 * tests). The same decision table drives both platforms. */
class AidenRunInputTest {
    private fun result(
        status: AidenStreamInputStatus,
        queue: AidenStreamInputQueue? = null,
        reason: AidenStreamInputRejectionReason? = null,
        committed: Boolean = false
    ) = AidenStreamInputResult(
        streamId = "stream-1",
        chatId = "chat-1",
        turnId = "turn-1",
        mode = AidenStreamInputMode.STEER,
        status = status,
        queue = queue,
        reason = reason,
        committed = committed,
        messageId = if (committed) "message-1" else null
    )

    @Test
    fun runInputOptionsRequireBusyControlledSupportedDraft() {
        assertTrue(AidenRunInputPresentation.offersRunInput(
            isStreaming = true, canControl = true, supports = true, hasDraft = true
        ))
        // Old servers keep the Stop-only control.
        assertFalse(AidenRunInputPresentation.offersRunInput(
            isStreaming = true, canControl = true, supports = false, hasDraft = true
        ))
        assertFalse(AidenRunInputPresentation.offersRunInput(
            isStreaming = false, canControl = true, supports = true, hasDraft = true
        ))
        assertFalse(AidenRunInputPresentation.offersRunInput(
            isStreaming = true, canControl = false, supports = true, hasDraft = true
        ))
        assertFalse(AidenRunInputPresentation.offersRunInput(
            isStreaming = true, canControl = true, supports = true, hasDraft = false
        ))
    }

    @Test
    fun runInputDraftConsumedOnlyForCommittedOutcomes() {
        assertTrue(AidenRunInputPresentation.consumesDraft(
            result(AidenStreamInputStatus.ADMITTED)
        ))
        assertTrue(AidenRunInputPresentation.consumesDraft(
            result(
                AidenStreamInputStatus.REJECTED,
                reason = AidenStreamInputRejectionReason.RUN_NOT_ACTIVE,
                committed = true
            )
        ))
        assertFalse(AidenRunInputPresentation.consumesDraft(
            result(
                AidenStreamInputStatus.REJECTED,
                reason = AidenStreamInputRejectionReason.CAPACITY,
                committed = false
            )
        ))
    }

    @Test
    fun runInputConsumedDraftPreservesInFlightTyping() {
        assertEquals(
            "",
            AidenRunInputPresentation.consumedDraft("fix it", "fix it")
        )
        assertEquals(
            "please",
            AidenRunInputPresentation.consumedDraft("fix it", "fix it\nplease")
        )
        assertEquals(
            "different",
            AidenRunInputPresentation.consumedDraft("fix it", "different")
        )
    }

    @Test
    fun runInputReceiptsCoverAdmittedAndCommittedRejections() {
        assertEquals(
            "Steering the current run",
            AidenRunInputPresentation.receipt(
                result(AidenStreamInputStatus.ADMITTED, queue = AidenStreamInputQueue.STEER)
            )
        )
        assertEquals(
            "Queued to run next",
            AidenRunInputPresentation.receipt(
                result(AidenStreamInputStatus.ADMITTED, queue = AidenStreamInputQueue.FOLLOW_UP)
            )
        )
        assertEquals(
            "Saved to the chat — the run ended before it could use it",
            AidenRunInputPresentation.receipt(
                result(
                    AidenStreamInputStatus.REJECTED,
                    reason = AidenStreamInputRejectionReason.RUN_NOT_ACTIVE,
                    committed = true
                )
            )
        )
        assertNull(AidenRunInputPresentation.receipt(
            result(
                AidenStreamInputStatus.REJECTED,
                reason = AidenStreamInputRejectionReason.CAPACITY,
                committed = false
            )
        ))
    }

    @Test
    fun runInputRejectionMessagesKeepDraftSemantics() {
        for (reason in AidenStreamInputRejectionReason.values()) {
            assertTrue(
                "$reason must promise draft retention",
                AidenRunInputPresentation.rejectionMessage(reason).contains("unchanged")
            )
        }
        assertTrue(AidenRunInputPresentation.rejectionMessage(null).contains("unchanged"))
    }

    @Test
    fun runInputIdempotencyKeyReusesOnlyIdenticalAttempts() {
        val attempt = AidenRunInputPresentation.Attempt(
            key = UUID.randomUUID(), streamId = "stream-1",
            mode = AidenStreamInputMode.STEER, text = "hold on"
        )
        assertTrue(AidenRunInputPresentation.reusesIdempotencyKey(
            attempt, "stream-1", AidenStreamInputMode.STEER, "hold on"
        ))
        assertFalse(AidenRunInputPresentation.reusesIdempotencyKey(
            attempt, "stream-1", AidenStreamInputMode.QUEUE, "hold on"
        ))
        assertFalse(AidenRunInputPresentation.reusesIdempotencyKey(
            attempt, "stream-1", AidenStreamInputMode.STEER, "different"
        ))
        assertFalse(AidenRunInputPresentation.reusesIdempotencyKey(
            attempt, "stream-2", AidenStreamInputMode.STEER, "hold on"
        ))
        assertFalse(AidenRunInputPresentation.reusesIdempotencyKey(
            null, "stream-1", AidenStreamInputMode.STEER, "hold on"
        ))
    }
}
