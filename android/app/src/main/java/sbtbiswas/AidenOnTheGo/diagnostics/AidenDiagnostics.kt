package sbtbiswas.AidenOnTheGo.diagnostics

import android.util.Log

enum class AidenDiagnosticArea(val wireValue: String) {
    APP("app"), CONNECTION("connection"), AUTHENTICATION("authentication"), CONTRACT("contract"),
    CACHE("cache"), STREAM("stream"), SPEECH("speech"), NOTIFICATION("notification"),
    LIVE_ACTIVITY("liveActivity"), PRIOR_TERMINATION("priorTermination")
}

enum class AidenDiagnosticEvent(val wireValue: String) {
    LAUNCH("launch"), REQUEST_FAILED("requestFailed"), CONTRACT_REJECTED("contractRejected"),
    CACHE_FAILED("cacheFailed"), STREAM_INTERRUPTED("streamInterrupted"), SPEECH_FAILED("speechFailed"),
    NOTIFICATION_FAILED("notificationFailed"), LIVE_ACTIVITY_FAILED("liveActivityFailed"),
    PRIOR_TERMINATION_OBSERVED("priorTerminationObserved")
}

enum class AidenDiagnosticOutcome(val wireValue: String) {
    STARTED("started"), COMPLETED("completed"), DEGRADED("degraded"), FAILED("failed"), CANCELLED("cancelled")
}

enum class AidenDiagnosticCode(val wireValue: String) {
    NETWORK("network"), UNAUTHORIZED("unauthorized"), INVALID_RESPONSE("invalidResponse"),
    CORRUPT_DATA("corruptData"), UNAVAILABLE("unavailable"), CRASH("crash"),
    LOW_MEMORY("lowMemory"), ANR("anr"), UNKNOWN("unknown")
}

class AidenDiagnosticRecord internal constructor(
    val area: AidenDiagnosticArea,
    val event: AidenDiagnosticEvent,
    val outcome: AidenDiagnosticOutcome,
    val code: AidenDiagnosticCode
) {
    internal fun message(): String =
        "area=${area.wireValue} event=${event.wireValue} outcome=${outcome.wireValue} code=${code.wireValue}"
}

object AidenDiagnostics {
    private const val TAG = "AidenDiagnostics"
    @Volatile
    internal var testSink: ((AidenDiagnosticRecord) -> Unit)? = null

    fun project(
        area: AidenDiagnosticArea,
        event: AidenDiagnosticEvent,
        outcome: AidenDiagnosticOutcome,
        code: AidenDiagnosticCode = AidenDiagnosticCode.UNKNOWN
    ): AidenDiagnosticRecord = AidenDiagnosticRecord(area, event, outcome, code)

    fun record(
        area: AidenDiagnosticArea,
        event: AidenDiagnosticEvent,
        outcome: AidenDiagnosticOutcome,
        code: AidenDiagnosticCode = AidenDiagnosticCode.UNKNOWN
    ) {
        val record = project(area, event, outcome, code)
        try {
            testSink?.invoke(record)
        } catch (_: RuntimeException) {
            // Test observation must preserve the same non-interference guarantee as platform logging.
        }
        val message = record.message()
        try {
            when (outcome) {
                AidenDiagnosticOutcome.FAILED -> Log.e(TAG, message)
                AidenDiagnosticOutcome.DEGRADED -> Log.w(TAG, message)
                AidenDiagnosticOutcome.STARTED,
                AidenDiagnosticOutcome.COMPLETED,
                AidenDiagnosticOutcome.CANCELLED -> Log.i(TAG, message)
            }
        } catch (_: RuntimeException) {
            // Diagnostics must never replace the application behavior being observed.
        }
    }
}
