package sbtbiswas.AidenOnTheGo.features.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Word-boundary reveal for a streaming reply, layered over the frame batching
 * of [AidenLiveTranscriptBuffer].
 *
 * There is no display pacing: each tick shows everything received up to the
 * last whitespace, so the screen never trails received text by more than one
 * tick. The trailing partial word is held back so a word never appears
 * half-typed, but only for one tick. If the previous tick held a fragment and
 * no whitespace has arrived since, the whole buffer is released, so CJK text,
 * long URLs and code never stall.
 *
 * Callers must use it from one thread (the main dispatcher in the app).
 */
class AidenStreamingRevealGate(
    private val scope: CoroutineScope,
    private val tickMillis: Long = DEFAULT_TICK_MILLIS,
    private val publish: (String) -> Unit
) {
    /** The text split into what one tick shows now and the fragment it keeps. */
    data class Cut(val shown: String, val held: String)

    private var target = ""
    private var shown = ""
    private var heldPreviousTick = false
    private var tick: Job? = null

    /** The text published so far. */
    val revealed: String get() = shown

    /**
     * Offers the whole reply received so far. Text that extends what is shown
     * waits for the next tick; anything else (a replaced or shortened reply)
     * is published at once, and an empty reply resets the gate.
     */
    fun submit(text: String) {
        if (text.isEmpty()) {
            reset()
            return
        }
        if (text == target) return
        target = text
        if (!text.startsWith(shown)) {
            flush()
            return
        }
        // The tick starts with the first new token and is not pushed back by
        // later ones, so a steady stream still reveals every tick.
        if (tick?.isActive != true) scheduleTick()
    }

    /** Shows everything received now, including a held fragment. */
    fun flush() {
        tick?.cancel()
        tick = null
        heldPreviousTick = false
        if (shown == target) return
        shown = target
        publish(shown)
    }

    /** Drops everything and publishes the empty reply immediately. */
    fun reset() {
        tick?.cancel()
        tick = null
        heldPreviousTick = false
        target = ""
        shown = ""
        publish("")
    }

    private fun scheduleTick() {
        tick = scope.launch {
            delay(tickMillis)
            tick = null
            reveal()
        }
    }

    private fun reveal() {
        val pending = target.substring(shown.length)
        val cut = cut(pending, heldPreviousTick)
        heldPreviousTick = cut.held.isNotEmpty()
        if (cut.shown.isNotEmpty()) {
            shown += cut.shown
            publish(shown)
        }
        // Only a held fragment needs another tick; new text schedules its own.
        if (heldPreviousTick) scheduleTick()
    }

    companion object {
        const val DEFAULT_TICK_MILLIS = 50L

        /**
         * Splits [pending] into the text to show now and the fragment to keep
         * buffered. [heldPreviousTick] is whether the previous tick held a
         * fragment. `shown + held` always reproduces [pending] exactly, and the
         * cut falls right after a whitespace character, so it never splits a
         * surrogate pair or a grapheme cluster.
         */
        fun cut(pending: String, heldPreviousTick: Boolean): Cut {
            val lastWhitespace = pending.indexOfLast { it.isWhitespace() }
            if (lastWhitespace < 0) {
                return if (heldPreviousTick) Cut(pending, "") else Cut("", pending)
            }
            val boundary = lastWhitespace + 1
            return Cut(pending.substring(0, boundary), pending.substring(boundary))
        }
    }
}
