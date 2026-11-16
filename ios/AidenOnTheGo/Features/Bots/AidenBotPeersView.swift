import SwiftUI

struct AidenBotPeersView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The Bot's own machine; nil follows the selected one.
    let machine: String?
    let botID: String; let botName: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var model: AidenBotPeersModel?
    @State private var context: AidenRemoteRequestContext?
    @State private var resourceOwner: String?
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        Group {
            if let model, model.botID == botID, context.map(coordinator.holds) == true, coordinator.botServer(on: machine)?.supportsBotPeers == true {
                AidenBotPeersForm(model: model, botName: botName) { exchange in
                    AidenBotPeerExchangeView(coordinator: coordinator, machine: machine, botID: botID, exchangeID: exchange.id)
                }
            } else {
                ContentUnavailableView("Bot peers unavailable", systemImage: "bubble.left.and.bubble.right",
                    description: Text("Connect to a computer that supports Bot peers and grants access to this Bot."))
            }
        }
        .navigationTitle("Bot peers")
        .onAppear { visible = true; updateActive() }
        .onDisappear { visible = false; updateActive() }
        .onChange(of: scenePhase) { _, _ in updateActive(); if scenePhase == .active { Task { await model?.load() } } }
        .task(id: "\(coordinator.botInstallation(on: machine)?.id ?? "")|\(botID)") {
            resourceOwner = botID
            guard coordinator.botServer(on: machine)?.supportsBotPeers == true, let current = try? coordinator.botContext(on: machine), let client = try? coordinator.remoteClient(for: current) else { return }
            context = current
            model = AidenBotPeersModel(botID: botID, transport: client,
                isCurrent: { resourceOwner == botID && visible && UIApplication.shared.applicationState == .active && coordinator.holds(current) && coordinator.botConnectionState(on: machine) == .connected && coordinator.botServer(on: machine)?.supportsBotPeers == true },
                mayWrite: { coordinator.botInstallation(on: machine)?.canWriteBots == true },
                mayReadExchanges: { coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true },
                store: .shared, scope: .init(instanceID: current.instanceId, deviceID: current.deviceId, botID: botID))
            updateActive(); await model?.load()
        }
        .onChange(of: coordinator.botConnectionState(on: machine) == .connected) { _, connected in
            updateActive(); if connected, scenePhase == .active, visible { Task { await model?.load() } }
        }
        .onChange(of: coordinator.botServer(on: machine)?.supportsBotPeers == true) { _, supported in updateActive(); if supported, visible, scenePhase == .active { Task { await model?.load() } } }
        .background(palette.canvas)
    }
    private func updateActive() { model?.setActive(visible && scenePhase == .active && coordinator.botConnectionState(on: machine) == .connected && coordinator.botServer(on: machine)?.supportsBotPeers == true) }
}

struct AidenBotPeersForm<ExchangeDestination: View>: View {
    @Bindable var model: AidenBotPeersModel
    let botName: String
    let destination: (AidenPeerExchangeSummary) -> ExchangeDestination
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var approval: Approval?
    @State private var revocation: Revocation?
    private struct Approval { let bot: AidenPeerCatalog.Bot; let catalogRevision: String; let visit: Int }
    private struct Revocation { let pair: AidenPeerPair; let visit: Int }
    var body: some View {
        Form {
            Section {
                Text("Approve a named pair so these Bots can request help in both directions. Each Bot keeps its own rules, access and spending limits. Approval doesn’t authorize protected actions or share unrelated history.")
                    .font(.subheadline).foregroundStyle(palette.secondary)
            }
            if model.loading { Section { ProgressView("Loading Bot peers") } }
            if let message = model.message { Section { Text(message).foregroundStyle(palette.secondary) } }
            if model.pending != nil {
                Section("Waiting for confirmation") {
                    Text("The computer may have saved this change. Its exact request is kept; other changes wait until the outcome is known.")
                    Button("Refresh peer settings") { Task { await model.load() } }.disabled(model.loading || !model.canWrite)
                    Button("Retry same request") { Task { await model.retry() } }.disabled(!model.canWrite || model.busy)
                }
            }
            if model.needsReview {
                Section("Changed on your computer") {
                    if let settings = model.settings { Text(settings.routingDescription.isEmpty ? "No saved routing description" : settings.routingDescription) }
                    Text("Refresh and review the current pairs and description before saving your retained draft.")
                    Button("Keep draft with current revision") { model.keepDraft() }.disabled(!model.canEdit)
                    Button("Use saved description") { model.useSaved() }.disabled(!model.canEdit)
                }
            }
            if model.settings != nil {
                Section {
                    TextField("How approved peers should use this Bot", text: $model.draft, axis: .vertical)
                        .lineLimit(3...8).disabled(!model.canEdit).accessibilityLabel("Routing description")
                    Button("Save description") { Task { await model.describe() } }.disabled(!model.canSaveDescription)
                } header: { Text("Routing description") } footer: {
                    Text("Shared only with approved peers. Describe the help this Bot offers; leave out secrets and unrelated instructions. Up to 1,000 Unicode characters and 2 KB.")
                }
                Section("Approved pairs") {
                    if model.settings?.pairs.isEmpty == true { Text("No approved peers yet").foregroundStyle(palette.secondary) }
                    ForEach(model.settings?.pairs ?? []) { pair in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(pair.peer.name)
                            Text("Requests allowed in both directions").font(.footnote).foregroundStyle(palette.secondary)
                            Button("Revoke pair", role: .destructive) { revocation = .init(pair: pair, visit: model.visitToken) }
                                .disabled(!model.canEdit || model.needsReview)
                                .accessibilityLabel("Revoke pair with \(pair.peer.name)")
                        }
                    }
                }
                Section("Approve another Bot") {
                    ForEach(model.catalog?.bots ?? []) { bot in
                        let paired = model.settings?.pairs.contains(where: { $0.peer.botId == bot.botId }) == true
                        Button {
                            if let revision = model.catalog?.revision { approval = .init(bot: bot, catalogRevision: revision, visit: model.visitToken) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(bot.name)
                                if !bot.available { Text("Unavailable").font(.footnote).foregroundStyle(palette.secondary) }
                                else if paired { Text("Already approved").font(.footnote).foregroundStyle(palette.secondary) }
                            }
                        }.disabled(!model.canApprove(bot)).accessibilityHint("Review and approve a pair in both directions")
                    }
                    if model.catalog?.bots.isEmpty == true { Text("No other Bots are available on this computer.").foregroundStyle(palette.secondary) }
                }
            }
            Section("Exchanges") {
                if !model.canReadExchanges { Text("Bot and chat read access are needed to inspect exchanges.").foregroundStyle(palette.secondary) }
                else if model.exchanges.isEmpty { Text("No peer exchanges yet").foregroundStyle(palette.secondary) }
                else {
                    ForEach(model.exchanges) { exchange in
                        NavigationLink { destination(exchange) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(exchange.title)
                                Text(exchange.direction == .sent ? "To \(exchange.recipient.name)" : "From \(exchange.sender.name)").font(.subheadline).foregroundStyle(palette.secondary)
                                Text(peerTitle(exchange.state.rawValue)).font(.footnote).foregroundStyle(palette.secondary)
                            }.accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            Section { Button("Refresh") { Task { await model.load() } }.disabled(model.loading || model.busy) }
        }
        .scrollContentBackground(.hidden).background(palette.canvas)
        .alert("Approve \(botName) and \(approval?.bot.name ?? "peer")?", isPresented: Binding(get: { approval != nil }, set: { if !$0 { approval = nil } })) {
            if let captured = approval {
                Button("Approve both directions") { Task { await model.approve(captured.bot, catalogRevision: captured.catalogRevision, visit: captured.visit) } }
            }
            Button("Cancel", role: .cancel) { approval = nil }
        } message: { Text("\(botName) and \(approval?.bot.name ?? "this peer") can request help from each other. Each keeps its own rules, access and spending limits. Neither Bot gains fresh approval for protected actions.") }
        .confirmationDialog("Revoke \(botName) and \(revocation?.pair.peer.name ?? "peer")?", isPresented: Binding(get: { revocation != nil }, set: { if !$0 { revocation = nil } }), titleVisibility: .visible) {
            if let captured = revocation { Button("Revoke both directions", role: .destructive) { Task { await model.revoke(captured.pair, visit: captured.visit) } } }
            Button("Cancel", role: .cancel) { revocation = nil }
        } message: { Text("New requests will be refused. Already admitted effects may remain; inspect active exchanges for their current outcome.") }
        .onDisappear { approval = nil; revocation = nil }
        .onChange(of: scenePhase) { _, phase in if phase != .active { approval = nil; revocation = nil } }
    }
}

struct AidenBotPeerExchangeView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The Bot's own machine; nil follows the selected one.
    let machine: String?
    let botID: String; let exchangeID: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var model: AidenBotPeerExchangeModel?
    @State private var context: AidenRemoteRequestContext?
    @State private var resourceOwner: String?
    var body: some View {
        Group {
            if let model, model.botID == botID, model.exchangeID == exchangeID, context.map(coordinator.holds) == true, coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true {
                AidenBotPeerExchangeForm(model: model)
            } else { ContentUnavailableView("Exchange unavailable", systemImage: "bubble.left.and.bubble.right", description: Text("Connect to the computer that owns it with Bot, chat and peer access.")) }
        }
        .navigationTitle("Peer exchange").navigationBarTitleDisplayMode(.inline)
        .onAppear { visible = true; updateActive() }
        .onDisappear { visible = false; updateActive() }
        .onChange(of: scenePhase) { _, phase in updateActive(); if phase == .active { Task { await model?.load() } } }
        .task(id: "\(coordinator.botInstallation(on: machine)?.id ?? "")|\(botID)|\(exchangeID)") {
            resourceOwner = "\(botID)|\(exchangeID)"
            guard coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true, let current = try? coordinator.botContext(on: machine), let client = try? coordinator.remoteClient(for: current) else { return }
            context = current
            model = AidenBotPeerExchangeModel(botID: botID, exchangeID: exchangeID, transport: client,
                isCurrent: { resourceOwner == "\(botID)|\(exchangeID)" && visible && UIApplication.shared.applicationState == .active && coordinator.holds(current) && coordinator.botConnectionState(on: machine) == .connected && coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true },
                mayWrite: { coordinator.botInstallation(on: machine)?.canWriteBots == true },
                store: .shared, scope: .init(instanceID: current.instanceId, deviceID: current.deviceId, botID: botID, exchangeID: exchangeID))
            updateActive(); await model?.load()
        }
        .onChange(of: coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true) { _, supported in updateActive(); if supported, visible, scenePhase == .active { Task { await model?.load() } } }
        .onChange(of: coordinator.botConnectionState(on: machine) == .connected) { _, connected in updateActive(); if connected, visible, scenePhase == .active { Task { await model?.load() } } }
    }
    private func updateActive() { model?.setActive(visible && scenePhase == .active && coordinator.botConnectionState(on: machine) == .connected && coordinator.botServer(on: machine)?.supportsBotPeerExchanges == true) }
}
struct AidenBotPeerExchangeForm: View {
    @Bindable var model: AidenBotPeerExchangeModel
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        Form {
            if model.loading { ProgressView("Loading exchange") }
            if let message = model.message { Section { Text(message).foregroundStyle(palette.secondary) } }
            if let detail = model.detail {
                Section(detail.summary.title) {
                    LabeledContent("From", value: detail.summary.sender.name)
                    LabeledContent("To", value: detail.summary.recipient.name)
                    LabeledContent("Kind", value: peerTitle(detail.summary.kind.rawValue))
                    LabeledContent("Status", value: peerTitle(detail.summary.state.rawValue))
                    LabeledContent("Return", value: peerTitle(detail.summary.returnState.rawValue))
                    if let reason = detail.summary.blockedReason { Text(reason).foregroundStyle(palette.secondary) }
                    if let stop = detail.summary.lastStop {
                        LabeledContent("Stop", value: peerTitle(stop.state.rawValue))
                        if let reason = stop.reason { Text(peerTitle(reason.rawValue)).foregroundStyle(palette.secondary) }
                    }
                }
                Section("Request") { Text(detail.request.text).textSelection(.enabled) }
                if let result = detail.result {
                    Section("Result · \(peerTitle(result.outcome.rawValue))") {
                        Text(result.text).textSelection(.enabled)
                        if result.truncated { Text("This result was truncated by the computer.").font(.footnote).foregroundStyle(palette.secondary) }
                    }
                }
                Section("Evidence") {
                    Button("Read source evidence") { Task { await model.loadEvidence(.source) } }
                    Button("Read result evidence") { Task { await model.loadEvidence(.result) } }
                }
                Section("Timing") {
                    LabeledContent("Created", value: peerDate(detail.summary.createdAt))
                    LabeledContent("Updated", value: peerDate(detail.summary.updatedAt))
                    LabeledContent("Expires", value: peerDate(detail.summary.expiresAt))
                }
                Section {
                    if model.pending != nil {
                        Text("Stop may already be accepted. The original request is retained until the linked work acknowledges its outcome.")
                        Button("Check same Stop") { Task { await model.retry() } }.disabled(!model.canWrite || model.busy)
                    } else if model.hasHostPendingStop {
                        Text("A Stop is already pending on the computer. Refresh to check its acknowledgement.")
                            .foregroundStyle(palette.secondary)
                    } else {
                        Button("Stop linked exchange", role: .destructive) { Task { await model.stop() } }.disabled(!model.canStop)
                    }
                    Text("Stop applies only to this linked exchange. It cannot undo earlier effects and doesn’t stop unrelated Bot work.").font(.footnote).foregroundStyle(palette.secondary)
                }
            }
            Section { Button("Refresh exchange") { Task { await model.load() } }.disabled(model.loading || model.busy) }
        }
        .scrollContentBackground(.hidden).background(palette.canvas)
        .sheet(isPresented: Binding(get: { model.evidence != nil }, set: { if !$0 { model.clearEvidence() } })) {
            NavigationStack {
                if let evidence = model.evidence {
                    ScrollView { VStack(alignment: .leading, spacing: 16) {
                        Text(evidence.text).textSelection(.enabled)
                        if evidence.truncated { Text("This evidence was truncated by the computer.").font(.footnote).foregroundStyle(palette.secondary) }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading) }
                    .navigationTitle(evidence.title).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.clearEvidence() } } }
                }
            }
        }
    }
}
private func peerTitle(_ raw: String) -> String { raw == "fyi" ? "FYI" : raw.replacingOccurrences(of: "_", with: " ").capitalized }
private func peerDate(_ ms: Int) -> String { Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened) }

/// Quiet metadata only; exchange content is fetched after explicit inspection.
struct AidenBotPeerTranscriptRow: View {
    let peer: AidenBotPeerEntry
    let open: () -> Void
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right").accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(peer.caption)
                if peer.isFinal { Text("Final update").font(.caption) }
            }
            Button("View exchange", action: open).accessibilityLabel("View exchange with \(peer.peerName)")
        }
        .font(.footnote).foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}
