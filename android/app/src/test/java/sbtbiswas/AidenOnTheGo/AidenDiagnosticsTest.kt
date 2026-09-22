package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import sbtbiswas.AidenOnTheGo.diagnostics.*

class AidenDiagnosticsTest {
    @Test
    fun diagnosticProjectionIsClosedAndContentFree() {
        val record = AidenDiagnostics.project(
            AidenDiagnosticArea.CONTRACT,
            AidenDiagnosticEvent.CONTRACT_REJECTED,
            AidenDiagnosticOutcome.FAILED,
            AidenDiagnosticCode.INVALID_RESPONSE
        )
        assertEquals(AidenDiagnosticArea.CONTRACT, record.area)
        assertEquals("area=contract event=contractRejected outcome=failed code=invalidResponse", record.message())
        assertFalse(record.message().contains("prompt"))
    }

    @Test
    fun priorTerminationReducerKeepsOnlyActionableCategories() {
        assertEquals(AidenDiagnosticCode.CRASH, AidenOnTheGoApp.projectPriorTerminationReason(android.app.ApplicationExitInfo.REASON_CRASH))
        assertEquals(AidenDiagnosticCode.ANR, AidenOnTheGoApp.projectPriorTerminationReason(android.app.ApplicationExitInfo.REASON_ANR))
        assertEquals(null, AidenOnTheGoApp.projectPriorTerminationReason(android.app.ApplicationExitInfo.REASON_USER_REQUESTED))
    }
}
