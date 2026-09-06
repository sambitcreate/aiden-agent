package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Test

class AidenAppVersionTest {
    @Test
    fun testClientVersionMatchesPublishedName() {
        assertEquals("0.1.0", AidenAppVersion.NAME)
    }
}
