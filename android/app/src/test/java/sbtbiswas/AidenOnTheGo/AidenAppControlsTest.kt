package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*

class AidenAppControlsTest {
    private val json = Json { ignoreUnknownKeys = true }
    @Test fun sharedControlsHaveNativeBooleanStateAndBoundedOperations() {
        val root = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
        val controls = root.getValue("appControls").jsonObject
        val panel = json.decodeFromJsonElement<AidenAppControlPanel>(controls.getValue("panel"))
        val snapshot = json.decodeFromJsonElement<AidenAppControlSnapshot>(controls.getValue("snapshot"))
        val operation = json.decodeFromJsonElement<AidenAppControlOperation>(controls.getValue("operation"))
        val receipt = json.decodeFromJsonElement<AidenAppControlReceipt>(controls.getValue("receipt"))
        assertEquals("memory", panel.topic)
        assertTrue(panel.isWireSafe)
        assertTrue(snapshot.isWireSafe)
        assertEquals(true, snapshot.rows.single().value.boolean)
        assertTrue(operation.isWireSafe)
        assertFalse(receipt.value.boolean)
        assertEquals(operation.operationId, receipt.operationId)
        assertTrue(receipt.isWireSafe)
        assertFalse(operation.copy(control = "shell").isWireSafe)
        assertFalse(snapshot.copy(rows = snapshot.rows + snapshot.rows).isWireSafe)
    }
    @Test fun malformedAdditivePanelsPreserveOrdinaryAnswer() {
        val message = json.decodeFromString<AidenChatMessage>("""{"id":"m","role":"assistant","text":"Readable answer","createdAt":"2026-10-03T00:00:00Z","appPanels":[{"version":999,"id":"bad","topic":"arbitrary","fallback":"ignored"}]}""")
        assertEquals("Readable answer", message.text)
        assertNull(message.appPanels)
        assertTrue(message.isWireSafe)
    }
}
