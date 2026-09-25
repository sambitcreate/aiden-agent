package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenComposerSuggestionQuery
import sbtbiswas.AidenOnTheGo.models.AidenRemoteSkillCatalogEntry
import sbtbiswas.AidenOnTheGo.models.AidenRemoteSkillSource
import sbtbiswas.AidenOnTheGo.models.AidenSkillContractCodec
import sbtbiswas.AidenOnTheGo.models.AidenTurnRequestBuilder
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

/** On The Go invocable-skill contract rules (iOS parity: AidenChatTests skill
 * catalog and composer-suggestion tests). The same decision table drives both
 * platforms: the client only ever sees bounded display metadata plus an opaque
 * lease the Mac redeems at turn admission. */
class AidenSkillTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun entryJson(
        invocationId: String = "sk1_${"a".repeat(43)}",
        name: String = "review-code",
        available: Boolean = true,
        description: String = "Review changes.",
        extra: String = ""
    ): String {
        val extras = buildList {
            if (!available) add(""""unavailableReason":"Shadowed."""")
            if (extra.isNotEmpty()) add(extra.trimEnd(','))
        }.joinToString(",")
        return """{"invocationId":"$invocationId","name":"$name","description":"$description","source":"workspace","available":$available${if (extras.isEmpty()) "" else ",$extras"}}"""
    }

    private fun catalogJson(entries: List<String>) =
        json.parseToJsonElement("""{"skills":[${entries.joinToString(",")}]}""")

    @Test
    fun skillCatalogCodecParsesBoundedEntries() {
        val catalog = AidenSkillContractCodec.parseCatalog(
            catalogJson(listOf(entryJson(), entryJson("sk1_${"b".repeat(43)}", "ship", false)))
        )
        assertEquals(2, catalog.skills.size)
        assertEquals("review-code", catalog.skills[0].name)
        assertEquals(AidenRemoteSkillSource.WORKSPACE, catalog.skills[0].source)
        assertTrue(catalog.skills[0].available)
        assertEquals("Shadowed.", catalog.skills[1].unavailableReason)

        // A skill with no description frontmatter legitimately projects "".
        val descriptionLess = AidenSkillContractCodec.parseCatalog(
            catalogJson(listOf(entryJson(description = "")))
        )
        assertEquals("", descriptionLess.skills[0].description)
    }

    @Test
    fun skillCatalogCodecFailsClosedOnUnsafeShapes() {
        // Unknown field fails closed.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenSkillContractCodec.parseCatalog(catalogJson(listOf(entryJson(extra = """"path":"/x",""""))))
        }
        // Invocation ids must match the opaque lease format exactly.
        for (bad in listOf("plain-name", "sk1_short", "sk2_${"a".repeat(43)}", "sk1_${"a".repeat(44)}")) {
            assertThrows(AidenRemoteContractException::class.java) {
                AidenSkillContractCodec.parseCatalog(catalogJson(listOf(entryJson(bad))))
            }
        }
        // Duplicate leases are ambiguous.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenSkillContractCodec.parseCatalog(catalogJson(listOf(entryJson(), entryJson(name = "other"))))
        }
        // Available entries must not carry an unavailable reason; unavailable
        // entries must carry one.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenSkillContractCodec.parseCatalog(catalogJson(listOf(entryJson(extra = """"unavailableReason":"x",""""))))
        }
        assertThrows(AidenRemoteContractException::class.java) {
            AidenSkillContractCodec.parseCatalog(
                catalogJson(listOf("""{"invocationId":"sk1_${"a".repeat(43)}","name":"n","description":"d","source":"global","available":false}"""))
            )
        }
        // Unknown source.
        assertThrows(AidenRemoteContractException::class.java) {
            AidenSkillContractCodec.parseCatalog(
                catalogJson(listOf(entryJson().replace("\"workspace\"", "\"registry\"")))
            )
        }
    }

    @Test
    fun composerSuggestionQueryTracksTrailingTriggerTokens() {
        val skill = AidenComposerSuggestionQuery.parse("/rev")
        assertEquals(AidenComposerSuggestionQuery.Kind.SKILL, skill?.kind)
        assertEquals("rev", skill?.query)
        assertEquals(0, skill?.tokenStart)

        val mention = AidenComposerSuggestionQuery.parse("check @docs/ap")
        assertEquals(AidenComposerSuggestionQuery.Kind.MENTION, mention?.kind)
        assertEquals("docs/ap", mention?.query)
        assertEquals(6, mention?.tokenStart)

        // Triggers must start the draft or follow whitespace.
        assertNull(AidenComposerSuggestionQuery.parse("see/rev"))
        assertNull(AidenComposerSuggestionQuery.parse("mail@home"))
        // Completed tokens and empty drafts do not open a palette.
        assertNull(AidenComposerSuggestionQuery.parse("/rev "))
        assertNull(AidenComposerSuggestionQuery.parse(""))
        assertNull(AidenComposerSuggestionQuery.parse("done "))
        // Bounded query length.
        assertNull(AidenComposerSuggestionQuery.parse("/${"x".repeat(257)}"))
        assertEquals("x".repeat(256), AidenComposerSuggestionQuery.parse("/${"x".repeat(256)}")?.query)
        // The whitespace class is the Unicode White_Space property — the same
        // set iOS's Character.isWhitespace implements. NEL and figure space
        // open a trigger; information separators (which Kotlin's native
        // isWhitespace would wrongly accept) do not.
        assertEquals(
            AidenComposerSuggestionQuery.Kind.SKILL,
            AidenComposerSuggestionQuery.parse("run\u0085/rev")?.kind
        )
        assertEquals(
            AidenComposerSuggestionQuery.Kind.SKILL,
            AidenComposerSuggestionQuery.parse("see\u2007/rev")?.kind
        )
        assertNull(AidenComposerSuggestionQuery.parse("see\u001C/rev"))
        assertNull(AidenComposerSuggestionQuery.parse("see/rev"))
    }

    @Test
    fun composerSuggestionQueryRanksPrefixAheadOfSubstring() {
        val query = AidenComposerSuggestionQuery.parse("/cod")!!
        assertTrue(query.compare("code-review", "decode") < 0)
        assertTrue(query.compare("decode", "code-review") > 0)
        assertTrue(query.matches("encode/decode"))
    }

    @Test
    fun turnRequestBuilderCarriesOnlyAvailableSkillLeases() {
        val available = AidenRemoteSkillCatalogEntry(
            invocationId = "sk1_${"a".repeat(43)}",
            name = "review-code",
            description = "Review changes.",
            source = AidenRemoteSkillSource.WORKSPACE,
            available = true,
            unavailableReason = null
        )
        val request = AidenTurnRequestBuilder.make(
            text = "Review this",
            providerId = null,
            modelId = null,
            thinkingLevel = null,
            attachments = emptyList(),
            skill = available
        )
        val skill = request.skill!!
        assertEquals(1, skill.version)
        assertEquals(available.invocationId, skill.invocationId)
        assertEquals("review-code", skill.displayName)
        assertEquals(AidenRemoteSkillSource.WORKSPACE, skill.source)

        assertNull(
            AidenTurnRequestBuilder.make(
                text = "t", providerId = null, modelId = null, thinkingLevel = null,
                attachments = emptyList(),
                skill = available.copy(available = false, unavailableReason = "nope")
            ).skill
        )
        assertNull(
            AidenTurnRequestBuilder.make(
                text = "t", providerId = null, modelId = null, thinkingLevel = null,
                attachments = emptyList()
            ).skill
        )
    }
}
