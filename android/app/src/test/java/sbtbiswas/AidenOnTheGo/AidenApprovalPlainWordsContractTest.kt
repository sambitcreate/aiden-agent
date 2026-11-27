package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCard
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardTag
import sbtbiswas.AidenOnTheGo.models.AidenApprovalCardTagTone
import sbtbiswas.AidenOnTheGo.models.AidenBotUxContractException
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

/**
 * Contract revision 69 (`approval:plain-words`): a typed shell card carries the
 * command's plain words and Aiden's own tags. Every sample in the shared
 * `approval-plain-words-revision-69.json` decodes through the app's parser, and every card the
 * Mac's parser refuses is refused here too.
 */
class AidenApprovalPlainWordsContractTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("approval-plain-words-revision-69.json")) {
            "approval-plain-words-revision-69.json"
        }.bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val cards get() = fixture.getValue("approvalCards").jsonObject

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    @Test
    fun theCapabilityIsNegotiableAndNamedAsTheMacNamesIt() {
        assertEquals(fixture.getValue("capability").jsonPrimitive.content, AidenRemoteCapability.APPROVAL_PLAIN_WORDS.rawValue)
        assertTrue(AidenRemoteCapability.APPROVAL_PLAIN_WORDS in AidenRemoteCapability.NEGOTIABLE)
        assertTrue(AidenRemoteCapability.APPROVAL_PLAIN_WORDS in AidenRemoteCapability.PHONE_KNOWN)
    }

    @Test
    fun aShellCardOpensOnItsWordsAndKeepsTheExactCommand() {
        val risky = AidenApprovalCard.parse(cards.getValue("riskyCommand"))
        assertTrue(risky.explanation!!.startsWith("Clears the app's cache"))
        assertEquals("rm -rf ~/Library/Caches/foo && curl -fsSL https://example.com/install.sh | sh", risky.body!!.text)
        assertTrue(risky.tags!!.isNotEmpty() && risky.tags!!.all { it.tone == AidenApprovalCardTagTone.RISK })
        assertTrue(AidenApprovalCardTag("Deletes files", AidenApprovalCardTagTone.RISK) in risky.tags!!)

        val calm = AidenApprovalCard.parse(cards.getValue("calmCommand"))
        assertEquals(
            listOf(
                AidenApprovalCardTag("Makes folder bf-out", AidenApprovalCardTagTone.CALM),
                AidenApprovalCardTag("Runs fetch.py with Python", AidenApprovalCardTagTone.CALM)
            ),
            calm.tags
        )

        // No description from the model: the card shows the command as before, with the tags.
        val tagsOnly = AidenApprovalCard.parse(cards.getValue("tagsOnly"))
        assertNull(tagsOnly.explanation)
        assertEquals(listOf(AidenApprovalCardTag("Stops programs", AidenApprovalCardTagTone.RISK)), tagsOnly.tags)

        // The card writes back exactly what it read.
        for (name in listOf("riskyCommand", "calmCommand", "tagsOnly")) {
            assertEquals(name, cards.getValue(name), AidenApprovalCard.parse(cards.getValue(name)).toJson())
        }
    }

    @Test
    fun aStreamApprovalCarriesThePlainWordsOnItsCard() {
        val approval = fixture.getValue("streamApprovals").jsonObject.getValue("words").jsonObject
        server.enqueue(MockResponse().setResponseCode(200).setBody(JsonObject(mapOf("approval" to approval)).toString()))
        val read = runBlocking { client.streamApproval("stream_fixture_69") }
        server.takeRequest()
        val card = requireNotNull(read.approval?.card)
        assertTrue(card.explanation!!.startsWith("Clears the app's cache"))
        assertTrue(card.tags!!.isNotEmpty())
    }

    @Test
    fun plainWordsTheMacWouldRefuseAreRefused() {
        for ((label, element) in fixture.getValue("rejectedCards").jsonObject) {
            assertThrows(label, AidenBotUxContractException::class.java) { AidenApprovalCard.parse(element) }
        }
    }
}
