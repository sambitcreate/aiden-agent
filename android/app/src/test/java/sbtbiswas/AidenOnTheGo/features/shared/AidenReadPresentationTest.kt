package sbtbiswas.AidenOnTheGo.features.shared

import org.junit.Assert.assertEquals
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenChatListLoadState
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenWorkspaceHomeListPresentation

class AidenReadPresentationTest {
    @Test
    fun savedContentIsNeverReplacedByARefreshOrAFailedRefresh() {
        assertEquals(
            AidenReadPresentation.CONTENT,
            AidenReadPresentation.of(hasContent = true, isFetching = true, hasSettled = false)
        )
        assertEquals(
            AidenReadPresentation.CONTENT,
            AidenReadPresentation.of(hasContent = true, isFetching = false, hasSettled = true, failed = true)
        )
    }

    @Test
    fun placeholdersShowOnlyWhileAFirstReadIsPending() {
        assertEquals(
            AidenReadPresentation.SKELETON,
            AidenReadPresentation.of(hasContent = false, isFetching = true, hasSettled = false)
        )
        // Nothing in flight yet, but the owner has not finished its first read either.
        assertEquals(
            AidenReadPresentation.SKELETON,
            AidenReadPresentation.of(hasContent = false, isFetching = false, hasSettled = false)
        )
        assertEquals(
            AidenReadPresentation.EMPTY,
            AidenReadPresentation.of(hasContent = false, isFetching = false, hasSettled = true)
        )
    }

    @Test
    fun aFailedFirstReadShowsTheErrorUntilARetryStarts() {
        assertEquals(
            AidenReadPresentation.FAILED,
            AidenReadPresentation.of(hasContent = false, isFetching = false, hasSettled = true, failed = true)
        )
        assertEquals(
            AidenReadPresentation.SKELETON,
            AidenReadPresentation.of(hasContent = false, isFetching = true, hasSettled = true, failed = true)
        )
    }

    @Test
    fun workspaceHomeWaitsWithPlaceholdersWhileConnectingInsteadOfClaimingItIsEmpty() {
        val connecting = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = true,
            isSearching = false,
            isLoading = false,
            connectionState = AidenConnectionState.CONNECTING,
            hasCompletedWorkspaceRefresh = false,
            chatListLoadState = AidenChatListLoadState.UNRESOLVED
        )
        assertEquals(AidenReadPresentation.SKELETON, connecting)

        // Connected, Workspaces read, but the chat list has not started yet.
        val beforeChats = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = true,
            isSearching = false,
            isLoading = false,
            connectionState = AidenConnectionState.CONNECTED,
            hasCompletedWorkspaceRefresh = true,
            chatListLoadState = AidenChatListLoadState.UNRESOLVED
        )
        assertEquals(AidenReadPresentation.SKELETON, beforeChats)
    }

    @Test
    fun workspaceHomeShowsSavedRowsWhileConnectingAndEmptyOnlyOnceSettled() {
        val cached = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = false,
            isSearching = false,
            isLoading = true,
            connectionState = AidenConnectionState.CONNECTING,
            hasCompletedWorkspaceRefresh = false,
            chatListLoadState = AidenChatListLoadState.UNRESOLVED
        )
        assertEquals(AidenReadPresentation.CONTENT, cached)

        val settledEmpty = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = true,
            isSearching = false,
            isLoading = false,
            connectionState = AidenConnectionState.CONNECTED,
            hasCompletedWorkspaceRefresh = true,
            chatListLoadState = AidenChatListLoadState.LOADED
        )
        assertEquals(AidenReadPresentation.EMPTY, settledEmpty)

        // Offline with nothing saved cannot get better by waiting.
        val offline = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = true,
            isSearching = false,
            isLoading = false,
            connectionState = AidenConnectionState.OFFLINE,
            hasCompletedWorkspaceRefresh = false,
            chatListLoadState = AidenChatListLoadState.UNRESOLVED
        )
        assertEquals(AidenReadPresentation.EMPTY, offline)
    }

    @Test
    fun aWorkspaceHomeSearchWithNoMatchesIsAnAnswerEvenDuringAFirstLoad() {
        val searching = aidenWorkspaceHomeListPresentation(
            projectionIsEmpty = true,
            isSearching = true,
            isLoading = true,
            connectionState = AidenConnectionState.CONNECTING,
            hasCompletedWorkspaceRefresh = false,
            chatListLoadState = AidenChatListLoadState.LOADING
        )
        assertEquals(AidenReadPresentation.EMPTY, searching)
    }

    @Test
    fun foregroundRevalidationWaitsForStaleDataAndNeverStacksOnAReadInFlight() {
        val loadedAt = 1_000_000L
        assertEquals(false, AidenRevalidation.isDue(loadedAt, loadedAt + 5_000, inFlight = false))
        assertEquals(true, AidenRevalidation.isDue(loadedAt, loadedAt + AidenRevalidation.STALE_AFTER_MILLIS, inFlight = false))
        assertEquals(false, AidenRevalidation.isDue(loadedAt, loadedAt + 10 * AidenRevalidation.STALE_AFTER_MILLIS, inFlight = true))
        // No successful read yet (or it failed): returning to the app retries at once.
        assertEquals(true, AidenRevalidation.isDue(null, loadedAt, inFlight = false))
    }
}
