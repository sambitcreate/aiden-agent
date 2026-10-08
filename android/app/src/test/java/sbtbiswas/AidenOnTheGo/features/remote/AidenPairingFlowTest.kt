package sbtbiswas.AidenOnTheGo.features.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class AidenPairingFlowTest {
    @Test
    fun cameraAccessNeedsSystemSettingsOnlyAfterAndroidStopsOfferingTheDialog() {
        assertEquals(AidenCameraAccess.GRANTED, aidenCameraAccess(granted = true, askedBefore = true, showRationale = false))
        assertEquals(AidenCameraAccess.REQUESTABLE, aidenCameraAccess(granted = false, askedBefore = false, showRationale = false))
        // Denied once: Android still shows its dialog, with a rationale.
        assertEquals(AidenCameraAccess.REQUESTABLE, aidenCameraAccess(granted = false, askedBefore = true, showRationale = true))
        // Denied again ("Don't allow"): only the settings page can grant it now.
        assertEquals(AidenCameraAccess.BLOCKED, aidenCameraAccess(granted = false, askedBefore = true, showRationale = false))
    }

    @Test
    fun setupCodesAreNormalisedIntoGroupsOfFour() {
        assertEquals("0123-4567-89AB-CDEF-GHJK", formatCrockfordCode("0123456789abcdefghjk"))
        assertEquals("ABCD-EFGH", formatCrockfordCode("ab-cd ef!gh"))
        assertEquals("excess characters are cut at 20", 24, formatCrockfordCode("0".repeat(30)).length)
    }
}
