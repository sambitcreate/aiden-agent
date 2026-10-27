package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.notifications.AidenNewChatLinkConsent
import java.time.Instant

class AidenNewChatLinkConsentTest {
    private fun target(workspace: String = "workspace") = AidenNewChatLinkConsent.Target(
        AidenPairingIdentity("mac", "phone", Instant.EPOCH), "My Mac", workspace, "Project",
        AidenPairingIdentity("mac", "phone", Instant.EPOCH)
    )

    @Test fun cancellationAndRevokedPairingNeverCreate() = runBlocking {
        val consent = AidenNewChatLinkConsent()
        val target = target()
        var creates = 0
        assertTrue(consent.propose(target))
        assertFalse(consent.propose(target("other")))
        consent.invalidate()
        assertNull(consent.approve(target.id, { true }))
        assertNull(consent.perform(target, { true }) { creates++; 1 })
        assertTrue(consent.propose(target))
        assertNull(consent.approve(target.id, { false }))
        assertNull(consent.perform(target, { true }) { creates++; 1 })
        assertEquals(0, creates)
    }

    @Test fun frozenApprovalIsConsumedBeforeSuspensionAndLateResultLosesAuthority() = runBlocking {
        val consent = AidenNewChatLinkConsent()
        val target = target()
        var creates = 0
        consent.propose(target)
        assertEquals("workspace", consent.approve(target.id, { true })?.workspaceId)
        val result = consent.perform(target, { true }) {
            creates++
            assertNull(consent.perform(target, { true }) { creates++; 2 })
            assertFalse(consent.propose(target("other")))
            consent.invalidate()
            1
        }
        assertNull(result)
        assertEquals(1, creates)
    }

    @Test fun validApprovalCreatesOnceAndExpiredOrChangedTargetsCannotRun() = runBlocking {
        val consent = AidenNewChatLinkConsent()
        val target = target()
        var creates = 0
        consent.propose(target)
        assertNull(consent.approve(target.id, { true }, target.createdAtMillis + 60_000))
        consent.propose(target)
        consent.approve(target.id, { true })
        assertNull(consent.perform(target, { false }) { creates++; 1 })
        consent.propose(target)
        consent.approve(target.id, { true })
        assertEquals(7, consent.perform(target, { true }) { creates++; 7 })
        assertNull(consent.perform(target, { true }) { creates++; 8 })
        assertEquals(1, creates)
    }
}
