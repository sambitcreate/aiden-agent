package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Coalesces composer keystrokes into one draft write per quiet period.
 *
 * [schedule] restarts the quiet-period timer, [flush] writes a pending value
 * immediately, and [writeNow] supersedes anything pending. Every value takes a
 * sequence number when it is accepted, so a slow write that started earlier
 * can never overwrite a newer one, whichever thread finishes first.
 */
class AidenDebouncedDraftWriter(
    private val scope: CoroutineScope,
    private val delayMillis: Long = DEFAULT_DELAY_MILLIS,
    private val write: (String) -> Unit
) {
    private val stateLock = Any()
    private val writeLock = Any()
    private var sequence = 0L
    private var pending: Pair<String, Long>? = null
    private var timer: Job? = null
    private var written = 0L

    val hasPendingWrite: Boolean
        get() = synchronized(stateLock) { pending != null }

    fun schedule(text: String) {
        synchronized(stateLock) {
            pending = text to ++sequence
            timer?.cancel()
            timer = scope.launch {
                delay(delayMillis)
                flush()
            }
        }
    }

    fun flush() {
        val next = synchronized(stateLock) {
            val value = pending ?: return
            pending = null
            value
        }
        commit(next.first, next.second)
    }

    fun writeNow(text: String) = reserveWrite(text).invoke()

    /** Supersedes pending keystrokes now and writes [text] on the writer's scope. */
    fun writeSoon(text: String) {
        val write = reserveWrite(text)
        scope.launch { write() }
    }

    /**
     * Orders [text] after every value accepted so far and returns the write to
     * run later, typically on an IO dispatcher. Keystrokes accepted after this
     * call still win over it.
     */
    fun reserveWrite(text: String): () -> Unit {
        val token = synchronized(stateLock) {
            pending = null
            timer?.cancel()
            timer = null
            ++sequence
        }
        return { commit(text, token) }
    }

    private fun commit(text: String, token: Long) {
        synchronized(writeLock) {
            if (token <= written) return
            written = token
            write(text)
        }
    }

    companion object {
        const val DEFAULT_DELAY_MILLIS = 500L
    }
}
