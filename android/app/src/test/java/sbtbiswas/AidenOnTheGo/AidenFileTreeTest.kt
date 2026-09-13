package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.workspaces.*
import sbtbiswas.AidenOnTheGo.models.*

class AidenFileTreeTest {
    private val entries = listOf(
        AidenWorkspaceFileEntry("opaque-a", "src/nested/a.kt", "a.kt", AidenWorkspaceFileKind.FILE),
        AidenWorkspaceFileEntry("opaque-b", "src/b.kt", "b.kt", AidenWorkspaceFileKind.FILE),
        AidenWorkspaceFileEntry("opaque-readme", "README.md", "README.md", AidenWorkspaceFileKind.FILE)
    )
    @Test fun expansionBuildsFoldersWithoutReplacingOpaqueFileIdentities() {
        assertEquals(listOf("README.md", "src"), AidenFileTree.rows(entries, emptySet(), "").map { it.displayPath })
        val expanded = AidenFileTree.rows(entries, setOf("src"), "")
        assertEquals(listOf("README.md", "src", "src/b.kt", "src/nested"), expanded.map { it.displayPath })
        assertEquals("opaque-b", expanded.first { it.name == "b.kt" }.id)
        assertEquals("opaque-a", AidenFileTree.rows(entries, setOf("src", "src/nested"), "").first { it.name == "a.kt" }.id)
        assertEquals("opaque-a", AidenFileTree.rows(entries, emptySet(), "a.kt").single().id)
    }
    @Test fun folderExpansionAndSearchRemainInRetainedFileState() {
        val state = AidenFilePaneState()
        state.searchQuery = "a.kt"; state.toggleDirectory("src")
        assertEquals(setOf("src"), state.expandedDirectories)
        state.toggleDirectory("src")
        assertTrue(state.expandedDirectories.isEmpty())
        assertEquals("a.kt", state.searchQuery)
    }
    @Test fun unifiedHeadersAreNotMistakenForAddedOrRemovedContent() {
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("+++ b/file.kt"))
        assertEquals(AidenDiffLineKind.HEADER, aidenDiffLineKind("--- a/file.kt"))
        assertEquals(AidenDiffLineKind.ADDITION, aidenDiffLineKind("+new value"))
        assertEquals(AidenDiffLineKind.DELETION, aidenDiffLineKind("-old value"))
        assertEquals(AidenDiffLineKind.CONTEXT, aidenDiffLineKind(" unchanged"))
    }
}
