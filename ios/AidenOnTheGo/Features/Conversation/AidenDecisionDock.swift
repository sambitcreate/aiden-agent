import SwiftUI

/// Stop, for a conversation whose composer isn't there to hold it.
struct AidenDockStop {
    let label: String
    let isEnabled: Bool
    let action: () -> Void
}

/// A question takes the composer's place until it's answered. The person's input
/// stays in the session, so a recording under the card keeps its way to end.
/// Approvals are not here: they stay in the transcript, with the composer in view.
struct AidenDecisionDock<Card: View>: View {
    let session: AidenComposerSession
    @ViewBuilder let card: () -> Card

    var body: some View {
        VStack(spacing: 0) {
            AidenComposerListeningBar(session: session)
            card()
        }
    }
}
