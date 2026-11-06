import Foundation

extension AidenChatViewModel {
    // MARK: - Slice G composer power

    /// Skills require the negotiated grant in addition to the advertised
    /// feature; old servers hide the palette and sends stay ordinary text.
    var canUseSkills: Bool {
        guard !isReadOnlyFixture,
              ownerServer?.supportsChatSkills == true,
              let installation = ownerInstallation else {
            return false
        }
        return installation.hasNegotiatedAccess(to: .skillsInvoke)
    }

    /// Roster mentions reuse the negotiated progress read the subagent sheet
    /// already gates on.
    var canMentionAgents: Bool { canReadAgentRoster }

    /// File mentions ride the existing bounded file-index grants; bot chats
    /// use the bot-conversation index, workspace chats the workspace index.
    var canMentionFiles: Bool {
        guard !isReadOnlyFixture,
              let installation = ownerInstallation else {
            return false
        }
        return installation.hasNegotiatedAccess(to: .filesRead)
    }

    /// The active trailing `/query` or `@query` token, or nil while the draft
    /// tail is ordinary text. Skill triggers stay hidden during a run: stream
    /// inputs cannot carry a skill lease, so offering the palette mid-flight
    /// would imply the selection applies to the steer.
    var composerSuggestionQuery: AidenComposerSuggestionQuery? {
        guard let query = AidenComposerSuggestionQuery.parse(draft: draft) else { return nil }
        switch query.kind {
        case .skill: return canUseSkills && !isStreaming ? query : nil
        case .mention: return (canMentionAgents || canMentionFiles) ? query : nil
        }
    }

    var composerSuggestions: [AidenComposerSuggestion] {
        guard let query = composerSuggestionQuery else { return [] }
        switch query.kind {
        case .skill:
            let matches = skillCatalog.filter { query.matches($0.name) }
            let ranked = matches.sorted { query.ranksBefore($0.name, $1.name) }
            return ranked.prefix(AidenComposerSuggestion.maximumVisibleRows).map { .skill($0) }
        case .mention:
            var rows: [AidenComposerSuggestion] = []
            if canMentionAgents {
                let agents = (agentRoster?.agents ?? mentionAgents ?? [])
                    .filter { query.matches($0.label) }
                    .sorted { query.ranksBefore($0.label, $1.label) }
                rows.append(contentsOf: agents.map { .agent($0) })
            }
            if canMentionFiles {
                let files = mentionFiles
                    .filter {
                        $0.kind == .file
                            && (query.matches($0.displayPath) || query.matches($0.name))
                    }
                    .sorted { query.ranksBefore($0.displayPath, $1.displayPath) }
                rows.append(contentsOf: files.map { .file($0) })
            }
            return Array(rows.prefix(AidenComposerSuggestion.maximumVisibleRows))
        }
    }

    /// Selects a palette skill, consuming the `/query` token. The lease is
    /// redeemed by the Mac at turn admission; the catalog row is never an
    /// authority by itself.
    func selectSkillSuggestion(_ entry: AidenRemoteSkillCatalogEntry) {
        guard entry.available,
              let query = composerSuggestionQuery, query.kind == .skill else { return }
        selectedSkill = entry
        draft.removeSubrange(query.tokenRange)
    }

    func clearSelectedSkill() {
        selectedSkill = nil
    }

    /// Replaces the trailing `@query` token with the chosen display text.
    /// Insertions are plain user text; the Mac assigns no client-side mention
    /// semantics beyond what the model already sees.
    func selectMentionSuggestion(_ suggestion: AidenComposerSuggestion) {
        guard let query = composerSuggestionQuery, query.kind == .mention else { return }
        let insertion: String
        switch suggestion {
        case .agent(let agent):
            insertion = "@\(agent.label) "
        case .file(let entry):
            insertion = "@\(entry.displayPath) "
        case .skill:
            return
        }
        draft.replaceSubrange(query.tokenRange, with: insertion)
    }

    /// Lazy per-open fetch: a trigger kind appearing for the first time kicks
    /// off its bounded read. Failures may retry on the next palette open; a
    /// completed read is reused for the chat's lifetime.
    func prefetchComposerSuggestionData() {
        switch composerSuggestionQuery?.kind {
        case .skill:
            ensureSkillCatalog()
        case .mention:
            ensureMentionAgents()
            ensureMentionFiles()
        case nil:
            // A fresh palette open may retry a failed read.
            skillCatalogRetryPending = true
            mentionAgentsRetryPending = true
            mentionFilesRetryPending = true
        }
    }

    private func ensureSkillCatalog() {
        guard skillCatalogRetryPending, !skillCatalogLoaded, skillCatalogTask == nil,
              let context = liveOwner else { return }
        skillCatalogRetryPending = false
        skillCatalogTask = Task { [weak self] in
            guard let self else { return }
            defer { skillCatalogTask = nil }
            do {
                let catalog = try await coordinator.remoteClient(for: context).chatSkills(chatId: chat.id)
                guard coordinator.isLive(context) else { return }
                skillCatalog = catalog.skills
                skillCatalogLoaded = true
            } catch let error where aidenIsCancellation(error) {
            } catch {
                _ = await coordinator.handleCredentialRevocation(error, context: context)
            }
        }
    }

    private func ensureMentionAgents() {
        guard canMentionAgents, mentionAgentsRetryPending, !mentionAgentsLoaded,
              mentionAgentsTask == nil, agentRoster == nil,
              let context = liveOwner else { return }
        mentionAgentsRetryPending = false
        mentionAgentsTask = Task { [weak self] in
            guard let self else { return }
            defer { mentionAgentsTask = nil }
            do {
                let roster = try await coordinator.remoteClient(for: context).agentRoster(chatId: chat.id)
                guard coordinator.isLive(context) else { return }
                mentionAgents = roster.isAvailable ? roster.agents : []
                mentionAgentsLoaded = true
            } catch let error where aidenIsCancellation(error) {
            } catch {
                _ = await coordinator.handleCredentialRevocation(error, context: context)
            }
        }
    }

    private func ensureMentionFiles() {
        guard canMentionFiles, mentionFilesRetryPending, !mentionFilesLoaded,
              mentionFilesTask == nil,
              let context = liveOwner else { return }
        mentionFilesRetryPending = false
        mentionFilesTask = Task { [weak self] in
            guard let self else { return }
            defer { mentionFilesTask = nil }
            do {
                let client = try coordinator.remoteClient(for: context)
                let index = chat.isBotChat
                    ? try await client.botConversationFiles(chatId: chat.id)
                    : try await client.workspaceFiles(workspaceId: chat.workspaceId)
                guard coordinator.isLive(context) else { return }
                mentionFiles = index.entries
                mentionFilesLoaded = true
            } catch let error where aidenIsCancellation(error) {
            } catch {
                _ = await coordinator.handleCredentialRevocation(error, context: context)
            }
        }
    }
}
