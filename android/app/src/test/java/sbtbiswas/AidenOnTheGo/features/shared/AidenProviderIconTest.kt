package sbtbiswas.AidenOnTheGo.features.shared

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

class AidenProviderIconTest {
    private val resolver = AidenProviderIconResolver

    // Gradle runs unit tests from the module directory (android/app).
    private val drawableDir = File("src/main/res/drawable")
    private val desktopLogoDir = File("../../renderer/assets/provider-logos")

    private fun drawableFile(slug: String) = File(drawableDir, "ic_provider_${slug.replace('-', '_')}.xml")

    private fun paints(slug: String): List<String> {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(drawableFile(slug))
        val paths = document.getElementsByTagName("path")
        return (0 until paths.length).flatMap { index ->
            val path = paths.item(index) as Element
            listOf("fillColor", "strokeColor").mapNotNull { name ->
                path.getAttributeNS("http://schemas.android.com/apk/res/android", name).takeIf { it.isNotEmpty() }
            }
        }
    }

    @Test
    fun everySupportedProviderHasItsOwnBundledLogo() {
        resolver.supportedSlugs.forEach { slug ->
            val res = resolver.logoRes(slug)
            assertNotNull("$slug has no logo", res)
            assertTrue("$slug logo id is unset", res != 0)
            assertTrue("$slug drawable is missing", drawableFile(slug).isFile)
        }
        val ids = resolver.supportedSlugs.map { resolver.logoRes(it) }
        assertEquals("two providers share a drawable", ids.size, ids.toSet().size)
    }

    @Test
    fun androidShipsExactlyTheLogosDesktopShips() {
        val desktopSlugs = desktopLogoDir.listFiles { file -> file.extension == "svg" }!!
            .map { it.nameWithoutExtension }
            .toSet()
        assertEquals(desktopSlugs, resolver.supportedSlugs)
    }

    @Test
    fun multicolorMarksAreKnownProviders() {
        assertTrue(resolver.multicolorSlugs.isNotEmpty())
        assertTrue(resolver.supportedSlugs.containsAll(resolver.multicolorSlugs))
    }

    @Test
    fun monoLogosPaintOneColorSoTheThemeTintCoversThem() {
        (resolver.supportedSlugs - resolver.multicolorSlugs).forEach { slug ->
            val colors = paints(slug).toSet()
            assertEquals("$slug should paint exactly one color, found $colors", 1, colors.size)
        }
    }

    @Test
    fun multicolorLogosKeepTheirBrandColors() {
        resolver.multicolorSlugs.forEach { slug ->
            val colors = paints(slug).toSet()
            assertTrue("$slug lost its brand color", colors.any { it.uppercase() != "#FF000000" })
        }
    }

    @Test
    fun modelAndCustomProviderIdsResolveToTheirLogo() {
        assertEquals("claude", resolver.slug("anthropic", "claude-sonnet-4"))
        assertEquals("anthropic", resolver.slug("anthropic"))
        assertEquals("grok", resolver.slug("xai", "grok-4"))
        assertEquals("google", resolver.slug(" Gemini "))
        assertEquals("ollama", resolver.slug("custom:ollama-2"))
        assertNull(resolver.slug("custom:ollama-01"))
        assertNull(resolver.slug("custom:my-server"))
        assertNull(resolver.logoRes("radius"))
    }
}
