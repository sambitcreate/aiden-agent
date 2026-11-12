import Foundation

/// An object that lives on one machine, keyed by the machine and the paired
/// device so identical object IDs on two machines never collide.
struct AidenHostObjectID: Hashable, Codable, Sendable {
    let instanceId: String
    let deviceId: String
    let objectId: String

    /// `<n>:<instance><n>:<device><n>:<object>`, where `n` is the UTF-8 byte
    /// length of the segment that follows. Length prefixes keep the key
    /// unambiguous when an ID contains `:`.
    var storageKey: String {
        [instanceId, deviceId, objectId]
            .map { "\($0.utf8.count):\($0)" }
            .joined()
    }

    init(instanceId: String, deviceId: String, objectId: String) {
        self.instanceId = instanceId
        self.deviceId = deviceId
        self.objectId = objectId
    }

    /// Parses a key produced by `storageKey`. Returns nil for a bad length,
    /// a non-canonical length (a leading zero), the wrong number of segments,
    /// or trailing bytes. Never traps, whatever the input.
    init?(storageKey: String) {
        let bytes = Array(storageKey.utf8)
        var cursor = 0
        var segments: [String] = []
        for _ in 0..<3 {
            var length = 0
            var digits = 0
            while cursor < bytes.count, (0x30...0x39).contains(bytes[cursor]) {
                // A length can never exceed the bytes that remain, so stop as
                // soon as it does. This also rules out integer overflow.
                guard digits == 0 || bytes[cursor - digits] != 0x30 else { return nil }  // canonical: no leading zero
                length = length * 10 + Int(bytes[cursor] - 0x30)
                guard length <= bytes.count else { return nil }
                cursor += 1
                digits += 1
            }
            guard digits > 0, cursor < bytes.count, bytes[cursor] == 0x3A else { return nil }
            cursor += 1
            guard length <= bytes.count - cursor,
                  let segment = String(bytes: bytes[cursor..<(cursor + length)], encoding: .utf8)
            else { return nil }
            segments.append(segment)
            cursor += length
        }
        guard cursor == bytes.count else { return nil }
        self.init(instanceId: segments[0], deviceId: segments[1], objectId: segments[2])
    }
}
