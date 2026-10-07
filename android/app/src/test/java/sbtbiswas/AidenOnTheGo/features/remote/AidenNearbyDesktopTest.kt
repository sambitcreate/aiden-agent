package sbtbiswas.AidenOnTheGo.features.remote

import org.junit.Assert.*
import org.junit.Test

class AidenNearbyDesktopTest {
    @Test fun discoveryRequiresCanonicalLocalHostnameAndBoundedPort() {
        assertEquals("https://studio.local:8765/api/aiden/v1", nearbyDesktopEndpoint("Studio.local.", 8765))
        for (host in listOf(null, "", "192.168.1.2", "studio.local.evil.test", "studio.local/path", "-studio.local", "studio..local")) {
            assertNull(nearbyDesktopEndpoint(host, 8765))
        }
        assertNull(nearbyDesktopEndpoint("studio.local", 0))
        assertNull(nearbyDesktopEndpoint("studio.local", 65536))
    }
}
