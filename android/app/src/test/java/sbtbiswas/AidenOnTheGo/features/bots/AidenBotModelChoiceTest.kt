package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelCapability
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.util.UUID

class AidenBotModelChoiceTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val catalog by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        json.decodeFromString<AidenRemoteContractFixture>(text).botCapabilityCatalog
    }

    @Test
    fun pickerListsEveryModelMarksImageReadersAndDisablesOnesTheMacCannotRun() {
        val signedOut = catalog.copy(providers = catalog.providers.map { it.copy(available = false) })
        val models = aidenBotModelPickerProviders(signedOut).flatMap { it.models }
        assertEquals(listOf("model_fixture", "vision_model_fixture"), models.map { it.id })
        assertTrue(models.none { it.available })
        val live = aidenBotModelPickerProviders(catalog).flatMap { it.models }.associateBy { it.id }
        assertEquals(listOf(AidenModelCapability.VISION), live.getValue("vision_model_fixture").capabilities)
        assertTrue(live.getValue("model_fixture").capabilities.isEmpty())
    }

    @Test
    fun aProviderThatIsUpStillListsItsDownModelsAsUnavailable() {
        val mixed = catalog.copy(
            providers = catalog.providers.map { provider ->
                provider.copy(available = true, models = provider.models.mapIndexed { i, m -> m.copy(available = i == 0) })
            }
        )
        val flags = aidenBotModelPickerProviders(mixed).flatMap { it.models }.map { it.available }
        assertEquals(listOf(true, false), flags)
    }

    @Test
    fun recommendedModelIsTheFirstOneTheMacCanRun() {
        assertEquals(AidenModelRoute("provider_fixture", "model_fixture"), aidenBotRecommendedModel(catalog))
    }

    @Test
    fun createWithoutAChoiceLeavesAccessToTheMacAndAChoiceIsSentAsFullAccess() {
        val draft = AidenBotCreateDraft(name = "Seer")
        assertNull(draft.request(catalog)!!.access)

        val chosen = draft.copy(model = AidenModelRoute("provider_fixture", "vision_model_fixture")).request(catalog)!!
        val access = chosen.access!!
        assertEquals(AidenBotAccessMode.FULL, access.accessMode)
        assertEquals("vision_model_fixture", access.modelId)
        assertEquals(catalog.revision, access.catalogRevision)
    }

    @Test
    fun aChoiceTheMacCannotRunCannotBeCreated() {
        val draft = AidenBotCreateDraft(name = "Seer", model = AidenModelRoute("provider_fixture", "missing"))
        assertNull(draft.request(catalog))
        assertNull(draft.copy(model = AidenModelRoute("provider_fixture", "model_fixture")).request(null))
        assertFalse(AidenBotCreateDraft(name = "").canCreate)
    }

    @Test
    fun aChosenModelThatVanishedFromTheCatalogIsFlaggedAndBlocksCreate() {
        val chosen = AidenBotCreateDraft(name = "Seer", model = AidenModelRoute("provider_fixture", "vision_model_fixture"))
        assertFalse(chosen.modelIsGone(catalog))
        assertFalse(chosen.modelIsGone(null))
        assertFalse(AidenBotCreateDraft(name = "Seer").modelIsGone(catalog))

        val withoutIt = catalog.copy(
            providers = catalog.providers.map { p -> p.copy(models = p.models.map { m -> m.copy(available = m.id != "vision_model_fixture") }) }
        )
        assertTrue(chosen.modelIsGone(withoutIt))
        assertNull(chosen.request(withoutIt))
    }

    private fun refused(code: AidenRemoteErrorCode) = AidenRemoteClientException.Server(
        409,
        AidenRemoteErrorEnvelope.Body(code = code, message = "refused", requestId = "req", retryable = false)
    )

    private val chosenDraft = AidenBotCreateDraft(name = "Seer", model = AidenModelRoute("provider_fixture", "model_fixture"))

    @Test
    fun anUncertainCreateReplaysTheSameRequestAndKeyAfterTheCatalogRevisionMoves() {
        val keys = ArrayDeque(List(3) { UUID.randomUUID() })
        val attempts = AidenBotCreateAttempts { keys.removeFirst() }
        val first = attempts.begin(chosenDraft, catalog)!!
        attempts.failed(first, IOException("connection lost"))

        // Something unrelated in the Mac's catalog changed, so a rebuilt request would differ.
        val refreshed = catalog.copy(revision = catalog.revision + "-next")
        assertNotEquals("the trap: a rebuilt request carries a new revision", first.request, chosenDraft.request(refreshed))

        assertTrue(attempts.replays(chosenDraft))
        val retry = attempts.begin(chosenDraft, refreshed)!!
        assertEquals("the Mac may have made it, so it replays that Bot", first.key, retry.key)
        assertEquals("the exact original body is resent", first.request, retry.request)
    }

    @Test
    fun anUncertainCreateStaysReplayableWhenTheChosenModelVanishedFromTheCatalog() {
        val attempts = AidenBotCreateAttempts()
        val first = attempts.begin(chosenDraft, catalog)!!
        attempts.failed(first, IOException("timed out"))

        val withoutIt = catalog.copy(
            providers = catalog.providers.map { p -> p.copy(models = p.models.map { m -> m.copy(available = false) }) }
        )
        assertTrue(chosenDraft.modelIsGone(withoutIt))
        assertTrue(attempts.replays(chosenDraft))
        assertEquals(first, attempts.begin(chosenDraft, withoutIt))
    }

    @Test
    fun aChangedModelAfterAnUncertainCreateGetsANewKey() {
        val keys = ArrayDeque(List(3) { UUID.randomUUID() })
        val attempts = AidenBotCreateAttempts { keys.removeFirst() }
        val first = attempts.begin(chosenDraft, catalog)!!
        attempts.failed(first, IOException("connection lost"))

        val changed = chosenDraft.copy(model = AidenModelRoute("provider_fixture", "vision_model_fixture"))
        assertFalse(attempts.replays(changed))
        val second = attempts.begin(changed, catalog)!!
        assertNotEquals("a different body under the old key is an idempotency_conflict", first.key, second.key)

        // Even an uncertain failure doesn't carry the key over to a renamed draft.
        attempts.failed(second, IOException("connection lost"))
        val renamed = attempts.begin(changed.copy(name = "Seer 2"), catalog)!!
        assertNotEquals(second.key, renamed.key)
    }

    @Test
    fun aDefiniteRefusalGetsANewKeyForTheSameDraft() {
        val keys = ArrayDeque(List(3) { UUID.randomUUID() })
        val attempts = AidenBotCreateAttempts { keys.removeFirst() }
        val first = attempts.begin(chosenDraft, catalog)!!
        attempts.failed(first, refused(AidenRemoteErrorCode.INVALID_REQUEST))

        assertFalse(attempts.replays(chosenDraft))
        val retry = attempts.begin(chosenDraft, catalog)!!
        assertNotEquals("the Mac replays a refused key's refusal", first.key, retry.key)
    }
}
