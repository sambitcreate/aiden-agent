package sbtbiswas.AidenOnTheGo.features.shared

/**
 * What a region backed by a read from the paired desktop shows. Aiden renders
 * cached or last-known data at once and revalidates in the background, so this
 * is decided the same way on every screen.
 */
enum class AidenReadPresentation {
    /** Saved or fresh data. A background refresh or a failed one never replaces it. */
    CONTENT,

    /** Shaped placeholders: a first read is still on its way and nothing is saved. */
    SKELETON,

    /** The read settled and there is genuinely nothing to show. */
    EMPTY,

    /** The first read failed and nothing is saved; show the error with a retry. */
    FAILED;

    companion object {
        /**
         * [hasContent] means anything is on hand, cached or fresh. [isFetching] is a read
         * in flight. [hasSettled] means a read for the current owner has finished, or none
         * can start (offline, unpaired), so waiting longer would only show placeholders
         * forever. [failed] is the outcome of the latest settled read.
         */
        fun of(
            hasContent: Boolean,
            isFetching: Boolean,
            hasSettled: Boolean,
            failed: Boolean = false
        ): AidenReadPresentation = when {
            hasContent -> CONTENT
            isFetching || !hasSettled -> SKELETON
            failed -> FAILED
            else -> EMPTY
        }
    }
}
