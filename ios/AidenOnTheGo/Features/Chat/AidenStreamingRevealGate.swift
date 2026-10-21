// Adapted from Hermex (`StreamingRevealGate`), MIT License,
// Copyright (c) 2026 Uzair Ansar. See THIRD_PARTY_NOTICES.md.

import Foundation

/// Decides how much buffered reply text one streaming reveal tick shows.
///
/// Replies arrive in uneven bursts (a slow token, then a paragraph at once
/// after a network hiccup). Showing each burst whole makes the text lurch, so
/// a tick shows a share of the backlog instead: a fixed fraction of what is
/// buffered, at least `minimumCharactersPerTick`. The display trails received
/// text by a few hundred milliseconds at most and drains a burst smoothly. A
/// backlog past `maximumBacklogCharacters` (a replayed reply, a long stall)
/// is shown down to that size at once, so the screen never falls far behind.
/// Under Reduce Motion there is no pacing: a tick shows every whole word.
///
/// Cuts land after whitespace, so a word never appears half-typed. A trailing
/// partial word is held back, but only for one tick: if the previous tick
/// held text and the buffer has no whitespace left, it is released (whole
/// when word-sized, otherwise paced by characters), so CJK text, long URLs
/// and code never stall. Splitting walks
/// `Character`s, so grapheme clusters are never split, and `shown + held`
/// always reproduces the buffer.
enum AidenStreamingRevealGate {
    /// How often buffered reply text is revealed while a reply streams.
    static let tick: Duration = .milliseconds(33)

    /// A tick shows at least 1/`drainTicks` of the backlog, so a burst
    /// drains over roughly `drainTicks` ticks (about a quarter second).
    static let drainTicks = 8

    /// The slowest reveal: about 90 characters a second at 30 ticks a second.
    static let minimumCharactersPerTick = 3

    /// The most text the display may trail what was received.
    static let maximumBacklogCharacters = 600

    /// A held fragment up to this long is released whole, as one word. A
    /// longer run with no whitespace (a URL, CJK text) is paced instead.
    static let maximumWholeFragmentCharacters = 24

    /// How many characters of a `backlog`-character buffer one tick shows
    /// before rounding up to a word boundary. Unpaced (Reduce Motion), a
    /// tick shows the whole backlog.
    static func characterBudget(forBacklog backlog: Int, paced: Bool = true) -> Int {
        guard backlog > 0 else { return 0 }
        guard paced else { return backlog }
        let share = (backlog + drainTicks - 1) / drainTicks
        let catchUp = backlog - maximumBacklogCharacters
        return min(backlog, max(minimumCharactersPerTick, share, catchUp))
    }

    /// Splits `pending` into the text to show now and the text to keep
    /// buffered. `heldPreviousTick` is whether the previous tick returned a
    /// non-empty `held`. With `paced` false (Reduce Motion) a tick shows
    /// everything up to the last whitespace.
    static func cut(
        _ pending: String,
        heldPreviousTick: Bool,
        paced: Bool = true
    ) -> (shown: String, held: String) {
        guard !pending.isEmpty else { return ("", "") }
        let budget = characterBudget(forBacklog: pending.count, paced: paced)
        // Whole words covering at least the budget.
        let budgetEnd = pending.index(pending.startIndex, offsetBy: budget - 1)
        if let wordEnd = pending[budgetEnd...].firstIndex(where: \.isWhitespace) {
            return split(pending, at: pending.index(after: wordEnd))
        }
        // The budget reaches into the last word: show up to it.
        if let lastWhitespace = pending.lastIndex(where: \.isWhitespace) {
            return split(pending, at: pending.index(after: lastWhitespace))
        }
        // No whitespace at all: hold a fragment for one tick, then release
        // it whole when it is word-sized, or a budget at a time.
        guard heldPreviousTick else { return ("", pending) }
        guard pending.count > maximumWholeFragmentCharacters else { return (pending, "") }
        return split(pending, at: pending.index(after: budgetEnd))
    }

    private static func split(_ text: String, at boundary: String.Index) -> (shown: String, held: String) {
        (String(text[..<boundary]), String(text[boundary...]))
    }
}

/// Turns a cumulative reply (each update repeats everything so far) into the
/// text to append, without re-reading what was already received.
///
/// The work per update is proportional to the new text: what was received is
/// known by its UTF-8 length, and only the bytes just before the join are
/// compared. A cumulative reply only appends while a run is live; a rewrite
/// shows up as a shorter text, a changed tail, or a join inside a character,
/// and each of those asks the caller to replace the reply instead.
enum AidenCumulativeReplyText {
    enum Update: Equatable {
        case append(String)
        case replace
    }

    /// Bytes compared at the join.
    static let joinCheckBytes = 64

    /// `receivedTail(n)` returns the last `n` UTF-8 bytes received.
    static func update(
        to text: String,
        receivedUTF8Count: Int,
        receivedTail: (Int) -> [UInt8]
    ) -> Update {
        let utf8 = text.utf8
        guard utf8.count >= receivedUTF8Count else { return .replace }
        let join = utf8.index(utf8.startIndex, offsetBy: receivedUTF8Count)
        let checked = min(receivedUTF8Count, joinCheckBytes)
        let incomingTail = utf8[utf8.index(join, offsetBy: -checked)..<join]
        guard incomingTail.elementsEqual(receivedTail(checked)),
              let suffix = String(utf8[join...]) else { return .replace }
        return .append(suffix)
    }
}
