package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Test

class AidenAppVersionTest {
    @Test
    fun testClientVersionMatchesGradleVersionName() {
        assertEquals(BuildConfig.VERSION_NAME, AidenAppVersion.NAME)
    }
}
