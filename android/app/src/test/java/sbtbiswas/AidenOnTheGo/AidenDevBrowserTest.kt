package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenDevBrowser
import sbtbiswas.AidenOnTheGo.models.AidenServer
import kotlinx.serialization.json.Json

class AidenDevBrowserTest {
    @Test fun allowsOnlyFullWebUrlsWithoutCredentials() {
        assertEquals("http://100.80.1.2:3000/path?q=1#fragment", AidenDevBrowser.url("http://100.80.1.2:3000/path?q=1#fragment"))
        assertEquals("https://example.com", AidenDevBrowser.url("https://example.com"))
        listOf("javascript:alert(1)", "file:///secret", "content://contacts", "intent://site", "data:text/html,hello", "http://user:secret@host", "http://host:99999", "localhost:3000", "http://host:0").forEach { assertNull(it, AidenDevBrowser.url(it)) }
    }
    @Test fun defaultUsesOnlyValidatedTailnetHostAndExplicitPort() {
        assertEquals("http://100.64.0.1:3000", AidenDevBrowser.defaultUrl("https://100.64.0.1:444/api/aiden/v1"))
        assertEquals("http://mac.example.ts.net:5173", AidenDevBrowser.defaultUrl("https://mac.example.ts.net/api", 5173))
        listOf("https://100.63.255.255", "https://100.128.0.0", "https://localhost", "https://example.com", "https://100.64.999.1").forEach { assertNull(AidenDevBrowser.defaultUrl(it)) }
        listOf("100.80.1.2", "mac.tail.ts.net").forEach { assertEquals(it, AidenDevBrowser.validatedHost(it)) }
        listOf("https://100.80.1.2", "100.80.1.2:3000", "user@mac.ts.net", "mac.ts.net/path", "mac.ts.net.evil.com", "100.064.0.1", "mac.ts.net.", "mac..ts.net").forEach { assertNull(AidenDevBrowser.validatedHost(it)) }
    }
    @Test fun localhostIsExplicitlyResolvedToMacOrRejectedWithoutHint() {
        assertEquals("http://100.80.1.2:3000/path?q=1#x", AidenDevBrowser.resolveForMac("http://localhost:3000/path?q=1#x", "100.80.1.2"))
        assertEquals("http://mac.tail.ts.net:5173", AidenDevBrowser.resolveForMac("127.0.0.1:5173", "mac.tail.ts.net"))
        assertNull(AidenDevBrowser.resolveForMac("http://0.0.0.0:3000", null))
        assertEquals("https://example.com", AidenDevBrowser.resolveForMac("https://example.com", null))
    }
    @Test fun chatPreviewRoutingSupportsTailnetAliasesButPreservesOrdinaryLinks() {
        listOf("http://100.80.1.2:3000/page", "http://mac.tail.ts.net:5173", "http://other.machine.ts.net:3000/").forEach { assertEquals(it, AidenDevBrowser.chatPreviewUrl(it)) }
        listOf("https://example.com", "http://example.com:3000", "http://100.63.1.2:3000", "http://100.128.1.2:3000", "http://100.080.1.2:3000", "https://mac.tail.ts.net", "http://mac.tail.ts.net", "http://mac.tail.ts.net.evil.com:3000", "file:///tmp/page", "http://user:secret@100.80.1.2:3000").forEach { assertNull(it, AidenDevBrowser.chatPreviewUrl(it)) }
    }
    @Test fun optionalHostRemainsBackwardCompatible() {
        val json = Json { ignoreUnknownKeys = true }
        val fixture = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().readText()
        val server = kotlinx.serialization.json.Json.parseToJsonElement(fixture).let { (it as kotlinx.serialization.json.JsonObject)["server"]!! }
        val withHost = (server as kotlinx.serialization.json.JsonObject).toMutableMap().apply { put("developmentHost", kotlinx.serialization.json.JsonPrimitive("100.80.1.2")) }
        assertEquals("100.80.1.2", json.decodeFromString<AidenServer>(kotlinx.serialization.json.JsonObject(withHost).toString()).developmentHost)
        assertNull(json.decodeFromString<AidenServer>(kotlinx.serialization.json.JsonObject(withHost - "developmentHost").toString()).developmentHost)
    }
}
