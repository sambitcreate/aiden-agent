package sbtbiswas.AidenOnTheGo

import java.nio.file.Files
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenFilePaneState
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileDocument
import sbtbiswas.AidenOnTheGo.persistence.AidenFileDraftStore

class AidenAdaptiveWorkspaceTest {
    @Test fun environmentSelectionUsesStableToolIdentity() {
        val saved = androidx.lifecycle.SavedStateHandle(mapOf("tool" to 3))
        val state = sbtbiswas.AidenOnTheGo.features.workspaces.AidenEnvironmentPaneState(saved)
        assertEquals("Browser", state.selectedTool.value)
        state.select("Subagents")
        val restored = sbtbiswas.AidenOnTheGo.features.workspaces.AidenEnvironmentPaneState(saved)
        assertEquals("Subagents", restored.selectedTool.value)
    }
    @Test fun navigationDestinationsRoundTripIncludingEnvironment() {
        val route: AidenScreen = AidenScreen.Environment("workspace", "chat")
        assertEquals(route, Json.decodeFromString<AidenScreen>(Json.encodeToString(route)))
    }
    @Test fun recoveryReacquiresFileHandleAndPreservesOriginalVersion() {
        val root = Files.createTempDirectory("aiden-file-draft-test").toFile()
        try {
            val store = AidenFileDraftStore(root)
            val old = AidenFilePaneState()
            old.configure(store, "mac-a", "workspace")
            old.open(AidenWorkspaceFileDocument("expired-handle", "file.txt", "original", "v1", false))
            old.edit("unsent")
            val restored = AidenFilePaneState()
            restored.configure(store, "mac-a", "workspace")
            restored.open(AidenWorkspaceFileDocument("fresh-handle", "file.txt", "remote changed", "v2", false))
            assertEquals("fresh-handle", restored.selectedFile!!.id)
            assertEquals("v1", restored.selectedFile!!.version)
            assertEquals("unsent", restored.draftContent)
            assertTrue(restored.isDirty)
            assertFalse(root.walkTopDown().first { it.isFile }.readText().contains("expired-handle"))
            assertNull(store.load("mac-b", "workspace"))
            assertNull(store.load("mac-a", "another-workspace"))
        } finally { root.deleteRecursively() }
    }
    @Test fun completedSaveDoesNotEraseTextTypedWhileRequestWasRunning() {
        val state = AidenFilePaneState()
        state.open(AidenWorkspaceFileDocument("id", "file.txt", "original", "v1", false))
        state.edit("submitted")
        state.edit("typed later")
        state.saved(AidenWorkspaceFileDocument("id", "file.txt", "submitted", "v2", false), "submitted")
        assertEquals("typed later", state.draftContent)
        assertEquals("submitted", state.originalContent)
        assertEquals("v2", state.selectedFile!!.version)
        assertTrue(state.isDirty)
    }
    @Test fun revokedSessionCannotRecreatePurgedDraft() {
        val root = Files.createTempDirectory("aiden-file-draft-test").toFile()
        try {
            val store = AidenFileDraftStore(root)
            val stale = store.generation("mac")
            val draft = AidenFileDraftStore.Draft("file", "a", "v1", "b")
            assertTrue(store.save("mac", "workspace", draft, stale))
            store.purge("mac")
            assertNull(store.load("mac", "workspace"))
            assertFalse(store.save("mac", "workspace", draft, stale))
            assertNull(store.load("mac", "workspace"))
        } finally { root.deleteRecursively() }
    }
    @Test fun reconnectSettlesOldOperationFlagsAndRequiresReview() {
        val files = AidenFilePaneState()
        files.isSaving = true
        files.connectionChanged()
        assertFalse(files.isSaving)
        assertTrue(files.errorMessage!!.contains("Review"))
        val git = sbtbiswas.AidenOnTheGo.features.workspaces.AidenGitPaneState()
        git.isOperating = true
        git.isCheckingPush = true
        git.lastFailedOperation = { error("Must not retry an old request") }
        git.connectionChanged()
        assertFalse(git.isOperating)
        assertFalse(git.isCheckingPush)
        assertNull(git.lastFailedOperation)
        assertTrue(git.lastError!!.contains("Review"))
    }
    @Test fun laterFileSelectionRejectsEarlierResponse() {
        val state = AidenFilePaneState()
        val first = state.beginOpen()
        val second = state.beginOpen()
        assertFalse(state.isLatestOpen(first))
        assertTrue(state.isLatestOpen(second))
    }
    @Test fun successfulSaveClearsRecovery() {
        val root = Files.createTempDirectory("aiden-file-draft-test").toFile()
        try {
            val store = AidenFileDraftStore(root)
            val state = AidenFilePaneState()
            state.configure(store, "mac", "workspace")
            state.open(AidenWorkspaceFileDocument("id", "file.txt", "a", "v1", false))
            state.edit("b")
            state.saved(AidenWorkspaceFileDocument("id", "file.txt", "b", "v2", false), "b")
            assertNull(store.load("mac", "workspace"))
            assertFalse(state.isDirty)
        } finally { root.deleteRecursively() }
    }
}
