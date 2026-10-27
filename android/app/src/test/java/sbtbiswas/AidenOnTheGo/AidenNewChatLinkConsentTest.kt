package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.notifications.AidenNewChatLinkConsent
import sbtbiswas.AidenOnTheGo.notifications.AidenExternalNewChatQueue
import sbtbiswas.AidenOnTheGo.notifications.AidenDeepLink
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationDestination
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationRequest
import java.time.Instant

class AidenNewChatLinkConsentTest {
    private fun target(workspace: String = "workspace") = AidenNewChatLinkConsent.Target(
        AidenPairingIdentity("mac", "phone", Instant.EPOCH), "My Mac", workspace, "Project",
        AidenPairingIdentity("mac", "phone", Instant.EPOCH)
    )

    @Test fun externalNewChatWaitsThroughConnectionAndWorkspaceRefreshThenOffersConsentOnce() {
        val queue = AidenExternalNewChatQueue()
        val pairing = target().pairing
        queue.receive(AidenDeepLink.parse("aiden-otg://new-chat-voice?instance=mac&workspace=project"), pairing, pairing)
        var presentations = 0
        repeat(3) { if (queue.takeIfReady(false) { true } != null) presentations++ }
        assertEquals(0, presentations)
        assertEquals("project", queue.waiting?.request?.workspaceId)
        val ready = queue.takeIfReady(true) { true }
        if (ready != null) presentations++
        assertFalse(ready?.request?.startsVoice == true)
        assertNull(queue.takeIfReady(true) { true })
        assertEquals(1, presentations)
    }

    @Test fun newerNavigationOrRevocationCannotResurrectAnOlderWaitingRequest() {
        val queue = AidenExternalNewChatQueue()
        val pairing = target().pairing
        fun request(workspace: String) = AidenNavigationRequest(AidenNavigationDestination.NewChat, "mac", workspace)
        queue.receive(request("old"), pairing, pairing)
        assertNull(queue.takeIfReady(false) { true })
        queue.receive(request("new"), pairing, pairing)
        assertEquals("new", queue.takeIfReady(true) { true }?.request?.workspaceId)
        queue.receive(request("revoked"), pairing, pairing)
        assertNull(queue.takeIfReady(false) { false })
        assertNull(queue.takeIfReady(true) { true })
        queue.receive(request("superseded"), pairing, pairing)
        queue.receive(AidenNavigationRequest(AidenNavigationDestination.Chat("existing"), "mac"), pairing, pairing)
        assertNull(queue.takeIfReady(true) { true })
    }

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
