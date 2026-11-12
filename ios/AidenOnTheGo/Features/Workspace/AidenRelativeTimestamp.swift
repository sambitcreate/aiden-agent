import SwiftUI

enum AidenRelativeTimestamp {
    static func text(for date: Date, now: Date = Date()) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 60 { return "just now" }

        let minutes = Int(elapsed / 60)
        if minutes < 60 { return minutes == 1 ? "1 min ago" : "\(minutes) mins ago" }

        let hours = Int(elapsed / 3_600)
        if hours < 24 { return hours == 1 ? "1 hr ago" : "\(hours) hrs ago" }

        let days = Int(elapsed / 86_400)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }
}

struct AidenRelativeTimestampView: View {
    let date: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(AidenRelativeTimestamp.text(for: date, now: context.date))
        }
    }
}
