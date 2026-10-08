import Foundation

extension AidenActivityMarkKind {
    /// Label and mark for the live response row while a turn streams, following
    /// the phase mapping in docs/activity-marks.md. Priority: approval, running
    /// tool, visible text, queued, then the thinking fallback.
    static func liveResponse(
        streamState: AidenStreamState?,
        runningToolName: String?,
        hasLiveText: Bool
    ) -> (label: String, mark: AidenActivityMarkKind) {
        if streamState == .waitingForApproval {
            return ("Waiting for approval", .glance)
        }
        if let runningToolName {
            let name = runningToolName.lowercased()
            if name == "render_artifact" {
                return ("Visualizing", .scanGrid)
            }
            // Same rule as the desktop: a whole name segment, so `thread_create` is not a read.
            let segments = name.split(whereSeparator: { $0 == "_" || $0 == ":" || $0 == "-" })
            let isSearch = segments.contains { searchSegments.contains(String($0)) }
            return isSearch ? ("Searching…", .scanGrid) : ("Working…", .quadShuffle)
        }
        if hasLiveText {
            return ("Responding…", .compose)
        }
        if streamState == .queued {
            return ("Preparing…", .bounce)
        }
        return ("Thinking", .triStep)
    }

    private static let searchSegments: Set<String> = ["find", "glob", "grep", "list", "read", "search"]
}
