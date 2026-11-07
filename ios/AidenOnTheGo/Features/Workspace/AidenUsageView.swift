import SwiftUI

/// Usage before its first read: the dashboard's outline, or an explanation
/// when the Mac can't be reached or the read failed.
struct AidenUsagePendingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let isOffline: Bool
    let failed: Bool
    let retry: () -> Void
    var unavailableMessage: LocalizedStringKey = "Usage appears once your Mac is reachable."
    var failedMessage: LocalizedStringKey = "Your Mac didn't return usage this time."
    var machinePicker: AidenNewWorkMachinePicker?

    var body: some View {
        NavigationStack {
            Group {
                if isOffline {
                    ContentUnavailableView(
                        "Usage Unavailable",
                        systemImage: "chart.bar.xaxis",
                        description: Text(unavailableMessage)
                    )
                } else if failed {
                    ContentUnavailableView {
                        Label("Usage Couldn't Load", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text(failedMessage)
                    } actions: {
                        Button("Try Again", action: retry)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack(spacing: 12) {
                            ForEach(0..<3, id: \.self) { _ in
                                AidenBotSkeletonBlock(width: nil, height: 72, radius: 14, reduceMotion: reduceMotion)
                            }
                        }
                        AidenBotSkeletonBlock(width: nil, height: 132, radius: 14, reduceMotion: reduceMotion)
                        ForEach(0..<4, id: \.self) { _ in
                            AidenBotSkeletonBlock(width: nil, height: 44, radius: 10, reduceMotion: reduceMotion)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(24)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Loading usage")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .safeAreaInset(edge: .top) {
                machinePicker?.padding(.horizontal, AidenSpacing.l)
            }
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// What a machine has used. It starts on the default machine and only ever shows
/// the machine it's on.
@MainActor
@Observable
final class AidenMachineUsageModel {
    let picker: AidenNewWorkPicker
    private(set) var usage: AidenUsageSummary?
    private(set) var providers: [AidenProvider] = []
    private(set) var loadFailed = false

    @ObservationIgnored private let coordinator: AidenRemoteCoordinator
    @ObservationIgnored private var shown: AidenNewWorkTarget?

    init(coordinator: AidenRemoteCoordinator, preferences: AidenMachinePreferencesStore? = nil) {
        self.coordinator = coordinator
        picker = AidenNewWorkPicker(coordinator: coordinator, kind: .reading, preferences: preferences)
    }

    private var connection: AidenHostConnection? {
        picker.target.flatMap { coordinator.hosts.connection(for: $0.instanceId) }
    }

    var isConnected: Bool { connection?.connectionState == .connected }

    /// Still connecting isn't unreachable: the page's outline holds its place.
    var isUnreachable: Bool {
        switch connection?.connectionState {
        case .connected, .connecting: false
        case .offline, .needsPairing, nil: true
        }
    }

    /// False for a machine that hasn't granted this phone a read of its usage.
    var sharesUsage: Bool { AidenHomeLoadPlan(installation: connection?.installation).loadsUsage }

    func load() async {
        if shown != picker.target {
            shown = picker.target
            usage = nil
            providers = []
            loadFailed = false
        }
        guard let target = picker.target, let connection, isConnected, sharesUsage,
              let owner = try? coordinator.ownerContext(for: target.instanceId) else { return }
        let readsCatalog = AidenHomeLoadPlan(installation: connection.installation).loadsModelCatalog
        do {
            let client = try coordinator.remoteClient(for: owner)
            async let loadedUsage = client.usage()
            async let loadedCatalog = readsCatalog ? try? client.modelCatalog() : nil
            let values = try await (loadedUsage, loadedCatalog)
            guard picker.target == target, coordinator.isLive(owner) else { return }
            usage = values.0
            providers = values.1?.providers ?? providers
            loadFailed = false
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: owner) { return }
            guard picker.target == target, coordinator.isLive(owner) else { return }
            loadFailed = usage == nil
        }
    }
}

/// Usage for one machine at a time, on the tab shell.
struct AidenMachineUsageView: View {
    private struct LoadID: Equatable {
        let target: AidenNewWorkTarget?
        let isConnected: Bool
    }

    @State private var model: AidenMachineUsageModel

    init(coordinator: AidenRemoteCoordinator) {
        _model = State(initialValue: AidenMachineUsageModel(coordinator: coordinator))
    }

    var body: some View {
        Group {
            if let usage = model.usage {
                AidenUsageView(
                    usage: usage,
                    providers: model.providers,
                    machinePicker: AidenNewWorkMachinePicker(picker: model.picker)
                )
            } else {
                AidenUsagePendingView(
                    isOffline: model.isUnreachable || !model.sharesUsage,
                    failed: model.loadFailed,
                    retry: { Task { await model.load() } },
                    unavailableMessage: model.sharesUsage
                        ? "Usage appears once this machine is reachable."
                        : "This machine doesn’t share usage with this phone.",
                    failedMessage: "This machine didn't return usage this time.",
                    machinePicker: AidenNewWorkMachinePicker(picker: model.picker)
                )
            }
        }
        .task(id: LoadID(target: model.picker.target, isConnected: model.isConnected)) {
            await model.load()
        }
    }
}

struct AidenUsageView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    let usage: AidenUsageSummary
    let providers: [AidenProvider]
    var machinePicker: AidenNewWorkMachinePicker?

    private var heatmapDays: [AidenUsageHeatmapDay] {
        AidenUsagePresentation.heatmapDays(for: usage)
    }

    private var maximumDailyTokens: Int {
        max(heatmapDays.map(\.tokens).max() ?? 0, 1)
    }

    private var completionRate: Double {
        AidenUsagePresentation.ratio(
            usage.totals.completedRequests,
            of: usage.totals.requests
        )
    }

    private var localRequestShare: Double {
        AidenUsagePresentation.ratio(
            usage.totals.localRequests,
            of: usage.totals.requests
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    machinePicker
                    usageHero
                    overviewGrid
                    tokenActivitySection
                    activityInsightsSection
                    modelSection
                    privacyNote
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 36)
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var usageHero: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your Activity")
                .font(.title2.weight(.bold))
                .foregroundStyle(palette.foreground)

            Text(AidenUsagePresentation.dateRangeText(for: usage))
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var overviewGrid: some View {
        VStack(spacing: 12) {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                spacing: 12
            ) {
                metricCard(
                    value: usage.totals.requests.formatted(),
                    label: "Requests",
                    symbol: "bolt.fill"
                )
                metricCard(
                    value: usage.totals.activeDays.formatted(),
                    label: "Active days",
                    symbol: "calendar"
                )
                metricCard(
                    value: AidenUsagePresentation.dayCount(usage.totals.currentStreak),
                    label: "Current streak",
                    symbol: "flame"
                )
                metricCard(
                    value: AidenUsagePresentation.dayCount(usage.totals.longestStreak),
                    label: "Longest streak",
                    symbol: "trophy"
                )
            }

            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.title2)
                    .foregroundStyle(palette.accent)
                    .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 3) {
                    Text(AidenUsagePresentation.tokenCount(usage.totals.tokens.total))
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundStyle(palette.foreground)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .allowsTightening(true)
                        .layoutPriority(1)
                    Text("Total tokens")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
            .aidenUsageCard(palette: palette)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(usage.totals.tokens.total.formatted()) total tokens")
        }
    }

    private func metricCard(value: String, label: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(width: 30, height: 30)
                .background(palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(palette.foreground)
                    .contentTransition(.numericText())
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
        .aidenUsageCard(palette: palette)
        .accessibilityElement(children: .combine)
    }

    private var tokenActivitySection: some View {
        usageSection(title: "Token activity") {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Daily totals")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    Text("Last 30 days")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(palette.sidebar, in: Capsule())
                }

                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 10),
                    spacing: 6
                ) {
                    ForEach(heatmapDays) { day in
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(activityColor(tokens: day.tokens))
                            .aspectRatio(1, contentMode: .fit)
                            .accessibilityElement()
                            .accessibilityLabel("\(day.date), \(day.tokens.formatted()) tokens")
                    }
                }

                HStack(spacing: 6) {
                    Text("Less")
                    ForEach(0..<5, id: \.self) { level in
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(activityColor(level: level))
                            .frame(width: 14, height: 14)
                    }
                    Text("More")
                }
                .font(.caption2)
                .foregroundStyle(palette.secondary)

                Divider().overlay(palette.secondary.opacity(0.18))

                tokenBreakdown
            }
            .padding(18)
            .aidenUsageCard(palette: palette)
        }
    }

    private var tokenBreakdown: some View {
        VStack(spacing: 14) {
            usageValueRow("Input", value: usage.totals.tokens.input.formatted(), color: palette.accent)
            usageValueRow("Output", value: usage.totals.tokens.output.formatted(), color: palette.success)
            usageValueRow("Reasoning", value: usage.totals.tokens.reasoning.formatted(), color: palette.warning)
            usageValueRow("Cache read", value: usage.totals.tokens.cacheRead.formatted(), color: palette.secondary)
        }
    }

    private var activityInsightsSection: some View {
        usageSection(title: "Activity insights") {
            VStack(spacing: 0) {
                insightRow("Completed requests", value: completionRate.formatted(.percent.precision(.fractionLength(0))))
                insightDivider
                insightRow("Local model share", value: localRequestShare.formatted(.percent.precision(.fractionLength(0))))
                insightDivider
                insightRow("Failed requests", value: usage.totals.failedRequests.formatted())
                insightDivider
                insightRow(
                    "Hosted cost",
                    value: usage.totals.hostedCostSummary
                )
            }
            .padding(.horizontal, 18)
            .aidenUsageCard(palette: palette)
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        if !usage.models.isEmpty {
            usageSection(title: "Most used models") {
                VStack(spacing: 0) {
                    ForEach(Array(usage.models.prefix(5).enumerated()), id: \.element.id) { index, model in
                        HStack(spacing: 12) {
                            AidenProviderIcon(
                                providerID: model.providerId,
                                providerLabel: model.providerLabel,
                                modelID: model.modelId,
                                artwork: providers.first { $0.id == model.providerId }?.artwork,
                                size: 20,
                                color: palette.accent
                            )
                                .frame(width: 34, height: 34)
                                .background(palette.sidebar, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.modelLabel)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(1)
                                Text(model.local ? "\(model.providerLabel) · Local" : model.providerLabel)
                                    .font(.caption)
                                    .foregroundStyle(palette.secondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 8)

                            Text("\(model.requests.formatted()) runs")
                                .font(.subheadline)
                                .foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(.vertical, 14)

                        if index < min(usage.models.count, 5) - 1 {
                            insightDivider
                        }
                    }
                }
                .padding(.horizontal, 18)
                .aidenUsageCard(palette: palette)
            }
        }
    }

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lock.shield")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(width: 28)

            Text("Privacy-safe aggregates are recorded by Aiden Agent on your desktop. Prompts, responses, chat IDs, workspace IDs, and file paths are not included.")
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func usageSection<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(palette.secondary)
                .padding(.leading, 4)
            content()
        }
    }

    private func usageValueRow(_ label: String, value: String, color: Color) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(palette.foreground)
            Spacer()
            Text(value)
                .foregroundStyle(palette.secondary)
                .monospacedDigit()
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private func insightRow(_ label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .foregroundStyle(palette.foreground)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(palette.secondary)
                .monospacedDigit()
        }
        .font(.body)
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }

    private var insightDivider: some View {
        Divider().overlay(palette.secondary.opacity(0.18))
    }

    private func activityColor(tokens: Int) -> Color {
        guard tokens > 0 else { return palette.sidebar }
        let normalized = min(Double(tokens) / Double(maximumDailyTokens), 1)
        return palette.accent.opacity(0.22 + (0.78 * normalized.squareRoot()))
    }

    private func activityColor(level: Int) -> Color {
        guard level > 0 else { return palette.sidebar }
        return palette.accent.opacity(0.18 + (Double(level) * 0.205))
    }
}

struct AidenUsageHeatmapDay: Identifiable, Equatable {
    let date: String
    let tokens: Int

    var id: String { date }
}

enum AidenUsagePresentation {
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = .current
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()

    static func ratio(_ value: Int, of total: Int) -> Double {
        guard total > 0 else { return 0 }
        return min(max(Double(value) / Double(total), 0), 1)
    }

    static func dayCount(_ value: Int) -> String {
        value == 1 ? "1 day" : "\(value) days"
    }

    static func tokenCount(_ value: Int, locale: Locale = .current) -> String {
        value.formatted(.number.locale(locale).grouping(.automatic))
    }

    static func dateRangeText(for usage: AidenUsageSummary) -> String {
        guard let start = dateFormatter.date(from: usage.startDate),
              let end = dateFormatter.date(from: usage.endDate) else {
            return String(localized: "Last 30 days")
        }
        return "\(displayFormatter.string(from: start))–\(displayFormatter.string(from: end))"
    }

    static func heatmapDays(for usage: AidenUsageSummary) -> [AidenUsageHeatmapDay] {
        let totalsByDate = Dictionary(uniqueKeysWithValues: usage.days.map { ($0.date, $0.tokens.total) })
        guard let start = dateFormatter.date(from: usage.startDate),
              let end = dateFormatter.date(from: usage.endDate),
              start <= end else {
            return usage.days.map { AidenUsageHeatmapDay(date: $0.date, tokens: $0.tokens.total) }
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = start
        var result: [AidenUsageHeatmapDay] = []
        while date <= end, result.count < 366 {
            let key = dateFormatter.string(from: date)
            result.append(AidenUsageHeatmapDay(date: key, tokens: totalsByDate[key] ?? 0))
            guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
            date = next
        }
        return result
    }
}

private extension View {
    func aidenUsageCard(palette: AidenPalette) -> some View {
        background(
            palette.raised,
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(palette.foreground.opacity(0.06), lineWidth: 0.5)
        }
    }
}
