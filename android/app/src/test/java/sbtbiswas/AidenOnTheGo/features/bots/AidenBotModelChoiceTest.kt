package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelCapability
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode

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
}
