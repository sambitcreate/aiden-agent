import Observation
import SwiftUI

/// Revision 44: what a chat or Bot says about its spending limit above the
/// composer. The words match the Mac and Android.
enum AidenSpendingCopy {
    struct Notice: Equatable {
        let title: String
        let body: String
        let allowMore: String
    }

    /// "$5.00", "$1,250.00"; an amount under half a cent reads "less than $0.01".
    static func usd(_ amount: Double) -> String {
        guard amount.isFinite, amount > 0 else { return "$0.00" }
        if amount < 0.005 { return "less than $0.01" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return "$" + (formatter.string(from: NSNumber(value: amount)) ?? String(format: "%.2f", amount))
    }

    /// Nothing while the chat or Bot is under 80% of its limit.
    static func notice(_ spending: AidenSpending, botName: String?) -> Notice? {
        let isBot = spending.period == .month
        let name = botName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let who = isBot ? (name.isEmpty ? "This Bot" : name) : "This chat"
        let period = isBot ? " this month" : ""
        let allowMore = "Allow \(usd(spending.allowMoreUsd)) more"
        switch spending.state {
        case .under:
            return nil
        case .nearing:
            return Notice(
                title: "\(who) has used \(usd(spending.spentUsd)) of its \(usd(spending.allowedUsd)) limit\(period).",
                body: isBot ? "\(who) stops when it reaches the limit." : "Replies stop when the chat reaches its limit.",
                allowMore: allowMore
            )
        case .reached:
            return Notice(
                title: "\(who) reached its \(usd(spending.allowedUsd)) spending limit\(period).",
                body: "It has spent \(usd(spending.spentUsd)). \(allowMore) to keep going, or change the limit on your Mac.",
                allowMore: allowMore
            )
        }
    }
}

/// The spending routes, so the model can be driven without a Mac.
protocol AidenSpendingTransport: Sendable {
    func spending(owner: AidenSpendingOwner) async throws -> AidenSpendingStatus
    func allowMoreSpending(owner: AidenSpendingOwner, revision: String) async throws -> AidenSpendingStatus
}

extension AidenRemoteClient: AidenSpendingTransport {}

@MainActor
@Observable
final class AidenSpendingNoticeModel {
    private(set) var spending: AidenSpending?
    private(set) var isAllowing = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var owner: AidenSpendingOwner?

    /// Reads the owner's status again. A Mac without the feature, or a failed
    /// read, shows nothing: the Mac still refuses a send over the limit.
    func refresh(owner: AidenSpendingOwner, transport: AidenSpendingTransport?) async {
        if self.owner != owner {
            self.owner = owner
            spending = nil
            errorMessage = nil
        }
        guard let transport else {
            spending = nil
            return
        }
        guard let status = try? await transport.spending(owner: owner), self.owner == owner else { return }
        spending = status.spending
    }

    /// Allow more once. A tap that crossed another (a second phone, the Mac)
    /// re-reads the status rather than adding twice.
    func allowMore(transport: AidenSpendingTransport?) async {
        guard let owner, let transport, let current = spending, !isAllowing else { return }
        isAllowing = true
        errorMessage = nil
        defer { isAllowing = false }
        do {
            let status = try await transport.allowMoreSpending(owner: owner, revision: current.revision)
            if self.owner == owner { spending = status.spending }
        } catch AidenRemoteClientError.server(let statusCode, let body)
            where statusCode == 409 || body.code == AidenRemoteErrorCode(rawValue: "revision_conflict") {
            await refresh(owner: owner, transport: transport)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// A quiet line from 80% of the limit; once it is reached, a card with Allow
/// more. Status lives in the icon's tint, never in a border.
struct AidenSpendingNotice: View {
    let spending: AidenSpending
    let botName: String?
    let isAllowing: Bool
    let canAllow: Bool
    let errorMessage: String?
    let onAllowMore: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        if let notice = AidenSpendingCopy.notice(spending, botName: botName) {
            if spending.state == .nearing {
                Label {
                    Text(notice.title)
                } icon: {
                    Image(systemName: "dollarsign.circle")
                        .foregroundStyle(palette.warning)
                }
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
                .padding(.bottom, 6)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Label {
                        Text(notice.title)
                            .foregroundStyle(palette.foreground)
                    } icon: {
                        Image(systemName: "dollarsign.circle.fill")
                            .foregroundStyle(palette.warning)
                    }
                    .font(.subheadline.weight(.semibold))
                    Text(notice.body)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(palette.danger)
                    }
                    Button(notice.allowMore, action: onAllowMore)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                        .disabled(isAllowing || !canAllow)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityElement(children: .contain)
                .padding(.bottom, 8)
            }
        }
    }
}
