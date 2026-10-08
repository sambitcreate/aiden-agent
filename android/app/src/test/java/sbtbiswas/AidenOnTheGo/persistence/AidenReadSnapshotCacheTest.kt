package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.AidenGitBranches
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission

class AidenReadSnapshotCacheTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val workspaces = ListSerializer(AidenWorkspace.serializer())

    private fun workspace(id: String, name: String) = AidenWorkspace(
        id = id,
        name = name,
        permission = AidenWorkspacePermission.ASK,
        revision = "rev-$id"
    )

    @Test
    fun aSnapshotSurvivesANewCacheInstanceForTheSameInstallationOnly() {
        val list = listOf(workspace("w1", "Aiden"), workspace("w2", "Docs"))
        AidenReadSnapshotCache(tempFolder.root).store("mac-one", AidenReadSnapshotKeys.WORKSPACES, list, workspaces)

        // A cold launch reads the file another process run wrote.
        val reopened = AidenReadSnapshotCache(tempFolder.root)
        assertEquals(list, reopened.load("mac-one", AidenReadSnapshotKeys.WORKSPACES, workspaces))
        assertNull(reopened.load("mac-two", AidenReadSnapshotKeys.WORKSPACES, workspaces))
    }

    @Test
    fun screenKeysForTheSameWorkspaceDoNotCollide() {
        val cache = AidenReadSnapshotCache(tempFolder.root)
        val branches = AidenGitBranches(current = "main", branches = listOf("main", "feature"))
        cache.store("mac", AidenReadSnapshotKeys.gitBranches("w1"), branches, AidenGitBranches.serializer())

        assertEquals(branches, cache.load("mac", AidenReadSnapshotKeys.gitBranches("w1"), AidenGitBranches.serializer()))
        assertNull(cache.load("mac", AidenReadSnapshotKeys.gitBranches("w2"), AidenGitBranches.serializer()))
        assertNull(cache.load("mac", AidenReadSnapshotKeys.gitWorktrees("w1"), AidenGitBranches.serializer()))
    }

    @Test
    fun purgeRemovesOnlyThatInstallationsSnapshots() {
        val cache = AidenReadSnapshotCache(tempFolder.root)
        cache.store("mac-one", AidenReadSnapshotKeys.WORKSPACES, listOf(workspace("w1", "One")), workspaces)
        cache.store("mac-one", AidenReadSnapshotKeys.gitReview("w1"), "review", String.serializer())
        cache.store("mac-two", AidenReadSnapshotKeys.WORKSPACES, listOf(workspace("w9", "Two")), workspaces)

        cache.purge("mac-one")

        val reopened = AidenReadSnapshotCache(tempFolder.root)
        assertNull(reopened.load("mac-one", AidenReadSnapshotKeys.WORKSPACES, workspaces))
        assertNull(reopened.load("mac-one", AidenReadSnapshotKeys.gitReview("w1"), String.serializer()))
        assertEquals("Two", reopened.load("mac-two", AidenReadSnapshotKeys.WORKSPACES, workspaces)?.single()?.name)
    }

    @Test
    fun anOversizedSnapshotIsRejectedAndDoesNotLeaveTheOlderOneBehind() {
        val cache = AidenReadSnapshotCache(tempFolder.root, maximumEntryBytes = 512)
        assertTrue(cache.store("mac", "notes", "short", String.serializer()))

        assertFalse(cache.store("mac", "notes", "x".repeat(2_048), String.serializer()))

        // Showing the older snapshot after a newer read could not be kept would roll the screen back.
        assertNull(cache.load("mac", "notes", String.serializer()))
    }

    @Test
    fun eachInstallationKeepsOnlyItsNewestSnapshots() {
        val cache = AidenReadSnapshotCache(tempFolder.root, maximumEntriesPerInstallation = 2)
        cache.store("mac", AidenReadSnapshotKeys.gitReview("w1"), "first", String.serializer())
        cache.store("mac", AidenReadSnapshotKeys.gitReview("w2"), "second", String.serializer())
        cache.store("other", AidenReadSnapshotKeys.gitReview("w1"), "elsewhere", String.serializer())
        cache.store("mac", AidenReadSnapshotKeys.gitReview("w3"), "third", String.serializer())

        assertNull(cache.load("mac", AidenReadSnapshotKeys.gitReview("w1"), String.serializer()))
        assertEquals("second", cache.load("mac", AidenReadSnapshotKeys.gitReview("w2"), String.serializer()))
        assertEquals("third", cache.load("mac", AidenReadSnapshotKeys.gitReview("w3"), String.serializer()))
        assertEquals("elsewhere", cache.load("other", AidenReadSnapshotKeys.gitReview("w1"), String.serializer()))
    }

    @Test
    fun rewritingASnapshotKeepsItNewest() {
        val cache = AidenReadSnapshotCache(tempFolder.root, maximumEntriesPerInstallation = 2)
        cache.store("mac", "a", "a1", String.serializer())
        cache.store("mac", "b", "b1", String.serializer())
        cache.store("mac", "a", "a2", String.serializer())
        cache.store("mac", "c", "c1", String.serializer())

        assertEquals("a2", cache.load("mac", "a", String.serializer()))
        assertNull(cache.load("mac", "b", String.serializer()))
    }

    @Test
    fun aCorruptSnapshotReadsAsMissing() {
        val cache = AidenReadSnapshotCache(tempFolder.root)
        cache.store("mac", AidenReadSnapshotKeys.WORKSPACES, listOf(workspace("w1", "One")), workspaces)
        tempFolder.root.walkTopDown().filter { it.isFile }.forEach { it.writeText("{not json") }

        assertNull(cache.load("mac", AidenReadSnapshotKeys.WORKSPACES, workspaces))
    }
}
