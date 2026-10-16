package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The viewer page's message channel (contract revision 34) and what a confirmed prompt does. */
class AidenVisualViewerModelTest {
    @Test
    fun parsesTheClosedMessageSet() {
        assertEquals(AidenVisualBridgeMessage.Ready, AidenVisualBridgeMessage.parse("""{"type":"ready"}"""))
        assertEquals(
            AidenVisualBridgeMessage.Prompt("Compare Q3 with Q2"),
            AidenVisualBridgeMessage.parse("""{"type":"prompt","text":"  Compare Q3 with Q2\n"}""")
        )
        assertEquals(
            AidenVisualBridgeMessage.OpenUrl("https://example.com/report?q=1#top"),
            AidenVisualBridgeMessage.parse("""{"type":"openUrl","url":"https://example.com/report?q=1#top"}""")
        )
        // Extra keys on a known message do not reject it.
        assertEquals(AidenVisualBridgeMessage.Ready, AidenVisualBridgeMessage.parse("""{"type":"ready","at":12}"""))
    }

    @Test
    fun ignoresUnknownTypesAndMalformedMessages() {
        val ignored = listOf(
            """{"type":"sendPrompt","text":"hi"}""",
            """{"type":"resize","height":300}""",
            """{"type":"READY"}""",
            """{"type":1}""",
            """{"text":"no type"}""",
            """["ready"]""",
            """"ready"""",
            "ready",
            "",
            "{",
            "[object Object]",
            "null"
        )
        for (raw in ignored) assertNull(raw, AidenVisualBridgeMessage.parse(raw))
    }

    @Test
    fun ignoresPromptsThatAreNotBoundedText() {
        val limit = AidenVisualBridgeMessage.MAXIMUM_PROMPT_LENGTH
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":42}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":["a"]}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":{"value":"a"}}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":null}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt"}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":"   "}"""))
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"prompt","text":"${"a".repeat(limit + 1)}"}"""))
        assertEquals(
            AidenVisualBridgeMessage.Prompt("a".repeat(limit)),
            AidenVisualBridgeMessage.parse("""{"type":"prompt","text":"${"a".repeat(limit)}"}""")
        )
    }

    @Test
    fun opensOnlyHttpsLinksWithAHostAndNoUserInfo() {
        val refused = listOf(
            "http://example.com",
            "javascript:alert(1)",
            "file:///etc/hosts",
            "content://sbtbiswas.AidenOnTheGo/secret",
            "intent://scan#Intent;scheme=zxing;end",
            "data:text/html,hi",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "https:///path-only",
            "https:example.com",
            "//example.com",
            "https://exa mple.com",
            "https://example.com/\nnext",
            "https://example.com/" + "a".repeat(AidenVisualBridgeMessage.MAXIMUM_URL_LENGTH)
        )
        for (url in refused) {
            assertFalse(url, AidenVisualBridgeMessage.isOpenableUrl(url))
            val escaped = url.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            assertNull(url, AidenVisualBridgeMessage.parse("""{"type":"openUrl","url":"$escaped"}"""))
        }
        assertNull(AidenVisualBridgeMessage.parse("""{"type":"openUrl","url":7}"""))
        assertTrue(AidenVisualBridgeMessage.isOpenableUrl("https://example.com"))
        assertTrue(AidenVisualBridgeMessage.isOpenableUrl("https://sub.example.com:8443/a/b?c=d"))
    }

    @Test
    fun aConfirmedPromptIsAppendedToTheDraftNeverReplacingIt() {
        assertEquals("Show March", AidenVisualPromptDraft.appended("", " Show March "))
        assertEquals("Draft so far\n\nShow March", AidenVisualPromptDraft.appended("Draft so far  \n", "Show March"))
        assertNull(AidenVisualPromptDraft.appended("Draft so far", "  "))
    }

    @Test
    fun promptsAndLinksAreLimitedToOneEveryThreeSeconds() {
        var now = 10_000L
        val throttle = AidenVisualBridgeThrottle { now }
        assertTrue(throttle.tryAcquire())
        now += 2_999
        assertFalse(throttle.tryAcquire())
        now += 1
        assertTrue(throttle.tryAcquire())
        now += 3_000
        assertTrue(throttle.tryAcquire())
    }
}
