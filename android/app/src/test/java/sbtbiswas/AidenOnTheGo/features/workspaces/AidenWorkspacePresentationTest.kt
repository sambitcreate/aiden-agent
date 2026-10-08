package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenThemeCatalog
import sbtbiswas.AidenOnTheGo.models.AidenBrowserBreadcrumb
import kotlin.math.max
import kotlin.math.min

class AidenWorkspacePresentationTest {
    private fun contrast(a: Color, b: Color): Float {
        val la = a.luminance()
        val lb = b.luminance()
        return (max(la, lb) + 0.05f) / (min(la, lb) + 0.05f)
    }

    private fun channelDelta(a: Color, b: Color): Float =
        maxOf(kotlin.math.abs(a.red - b.red), kotlin.math.abs(a.green - b.green), kotlin.math.abs(a.blue - b.blue))

    private val allPalettes = AidenThemeCatalog.palettes.values.flatten()

    @Test
    fun treeDepthCountsAncestorFoldersAndStopsAtTheIndentCap() {
        assertEquals(0, AidenFileTreeLayout.depth("README.md"))
        assertEquals(2, AidenFileTreeLayout.depth("src/main/App.kt"))
        val deep = (1..30).joinToString("/") { "d$it" }
        assertEquals(12, AidenFileTreeLayout.depth(deep))
    }

    @Test
    fun treeGuidesSitOnePerAncestorLevelCenteredInsideTheIndent() {
        assertTrue(AidenFileTreeLayout.guideCenters(0, 14f).isEmpty())
        assertEquals(listOf(7f, 21f, 35f), AidenFileTreeLayout.guideCenters(3, 14f))
        assertEquals(42f, AidenFileTreeLayout.indent(3, 14f))
        val guides = AidenFileTreeLayout.guideCenters(12, 14f)
        assertTrue(guides.all { it > 0f && it < AidenFileTreeLayout.indent(12, 14f) })
        assertEquals(AidenFileTreeLayout.guideCenters(12, 14f), AidenFileTreeLayout.guideCenters(40, 14f))
    }

    @Test
    fun breadcrumbTrailStartsAtRootsAndMarksOnlyTheDeepestCrumbCurrent() {
        val atRoot = aidenFolderCrumbs(emptyList())
        assertEquals(listOf("Roots"), atRoot.map { it.label })
        assertTrue(atRoot.single().isCurrent)
        assertNull(atRoot.single().location)

        val nested = aidenFolderCrumbs(
            listOf(AidenBrowserBreadcrumb("Users", "loc-users"), AidenBrowserBreadcrumb("projects", "loc-projects"))
        )
        assertEquals(listOf("Roots", "Users", "projects"), nested.map { it.label })
        assertEquals(listOf(null, "loc-users", "loc-projects"), nested.map { it.location })
        assertEquals(listOf(false, false, true), nested.map { it.isCurrent })
    }

    @Test
    fun diffLinesSeparateEditsFromFileHeadersAndHunks() {
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("diff --git a/x b/x"))
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("--- a/src/App.kt"))
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("+++ b/src/App.kt"))
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("+++ /dev/null"))
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("\\ No newline at end of file"))
        assertEquals(AidenDiffLineKind.HUNK, aidenDiffLineKind("@@ -1,3 +1,4 @@"))
        assertEquals(AidenDiffLineKind.ADDITION, aidenDiffLineKind("+val added = 1"))
        assertEquals(AidenDiffLineKind.ADDITION, aidenDiffLineKind("++counter"))
        assertEquals(AidenDiffLineKind.DELETION, aidenDiffLineKind("-val removed = 1"))
        assertEquals(AidenDiffLineKind.DELETION, aidenDiffLineKind("--- comment removed from SQL"))
        assertEquals(AidenDiffLineKind.CONTEXT, aidenDiffLineKind(" unchanged"))
        assertEquals(AidenDiffLineKind.CONTEXT, aidenDiffLineKind(""))
    }

    @Test
    fun diffInksStayReadableOnTheirFillsInEveryLightAndDarkPalette() {
        allPalettes.forEach { palette ->
            val colors = aidenDiffColors(palette)
            val addSurface = colors.additionFill.compositeOver(palette.raised)
            val removeSurface = colors.deletionFill.compositeOver(palette.raised)
            assertTrue(
                "addition ink contrast on ${palette.canvasHex}",
                contrast(colors.additionInk, addSurface) >= 4.5f
            )
            assertTrue(
                "deletion ink contrast on ${palette.canvasHex}",
                contrast(colors.deletionInk, removeSurface) >= 4.5f
            )
            assertTrue(
                "context ink contrast on ${palette.canvasHex}",
                contrast(colors.contextInk, palette.raised) >= 4.5f
            )
        }
    }

    @Test
    fun diffFillsTintAddedAndRemovedLinesDistinctlyAndLeaveNeutralLinesUnfilled() {
        allPalettes.forEach { palette ->
            val colors = aidenDiffColors(palette)
            val addSurface = colors.additionFill.compositeOver(palette.raised)
            val removeSurface = colors.deletionFill.compositeOver(palette.raised)
            assertTrue("addition tint on ${palette.canvasHex}", channelDelta(addSurface, palette.raised) >= 0.03f)
            assertTrue("deletion tint on ${palette.canvasHex}", channelDelta(removeSurface, palette.raised) >= 0.03f)
            assertTrue("add vs remove on ${palette.canvasHex}", channelDelta(addSurface, removeSurface) >= 0.03f)
            assertEquals(Color.Transparent, colors.fill(AidenDiffLineKind.CONTEXT))
            assertEquals(Color.Transparent, colors.fill(AidenDiffLineKind.HUNK))
            assertEquals(Color.Transparent, colors.fill(AidenDiffLineKind.HEADER))
        }
    }
}
