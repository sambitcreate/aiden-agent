// Adapted from Hermex (`StreamingRevealGate`), MIT License,
// Copyright (c) 2026 Uzair Ansar. See THIRD_PARTY_NOTICES.md.

import Foundation

/// Decides how much buffered reply text one streaming reveal tick shows.
///
/// There is no display pacing: a tick shows everything buffered up to the last
/// whitespace, so the screen never trails received text by more than one tick.
/// The trailing partial word is held back so a word never appears half-typed,
/// but only for one tick: if the previous tick held a fragment and no
/// whitespace has arrived since, the whole buffer is released, so CJK text,
/// long URLs and code never stall. Splitting walks `Character`s, so grapheme
/// clusters are never split, and `shown + held` always reproduces the buffer.
enum AidenStreamingRevealGate {
    /// How often buffered reply text is revealed while a reply streams.
    static let tick: Duration = .milliseconds(50)

    /// Splits `pending` into the text to show now and the fragment to keep
    /// buffered. `heldPreviousTick` is whether the previous tick returned a
    /// non-empty `held`.
    static func cut(_ pending: String, heldPreviousTick: Bool) -> (shown: String, held: String) {
        guard let lastWhitespace = pending.lastIndex(where: \.isWhitespace) else {
            return heldPreviousTick ? (pending, "") : ("", pending)
        }
        let boundary = pending.index(after: lastWhitespace)
        return (String(pending[..<boundary]), String(pending[boundary...]))
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
