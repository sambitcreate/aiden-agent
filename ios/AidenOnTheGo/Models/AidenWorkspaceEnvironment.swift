import Foundation

enum AidenWorkspaceFileKind: String, Codable, Sendable {
    case file
    case directory
    case symlink
}

struct AidenWorkspaceFileEntry: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let displayPath: String
    let name: String
    let kind: AidenWorkspaceFileKind
    let size: Int?
    let language: String?
}

struct AidenWorkspaceFileIndex: Codable, Equatable, Sendable {
    let snapshotId: String
    let entries: [AidenWorkspaceFileEntry]
    let truncated: Bool
    let maxEntries: Int
    let maxDepth: Int
}

struct AidenWorkspaceFileDocument: Codable, Equatable, Sendable {
    let id: String
    let displayPath: String
    let content: String
    let version: String
    let truncated: Bool
    let warning: String?
}

enum AidenGitFileStatus: String, Codable, Sendable {
    case added, modified, deleted, renamed, untracked, conflicted
}

struct AidenGitFile: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let displayPath: String
    let status: AidenGitFileStatus
    let staged: Bool?
    let additions: Int?
    let deletions: Int?
}

struct AidenGitCapability: Codable, Equatable, Sendable {
    let allowed: Bool
    let reason: String?
}

struct AidenGitReview: Codable, Equatable, Sendable {
    let kind: String
    let branch: String
    let uncommitted: Int
    let files: [AidenGitFile]
}

struct AidenGitDiff: Codable, Identifiable, Equatable, Sendable {
    let kind: String
    let displayPath: String
    let diff: String
    let truncated: Bool

    var id: String { displayPath }
}

struct AidenGitBranches: Codable, Equatable, Sendable {
    let kind: String
    let current: String
    let branches: [String]
}

struct AidenGitComparison: Codable, Equatable, Sendable {
    let kind: String
    let comparisonId: String
    let base: String
    let head: String
    let files: [AidenGitFile]
}

struct AidenGitPushCapability: Codable, Equatable, Sendable {
    let kind: String
    let allowed: Bool
    let reason: String?
    let remote: String?
    let branch: String?
}

struct AidenGitWorktree: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let branch: String
    let managed: Bool
}

struct AidenGitWorktrees: Codable, Equatable, Sendable {
    let kind: String
    let worktrees: [AidenGitWorktree]
}

struct AidenGitMutation: Codable, Equatable, Sendable {
    let kind: String
    let message: String
    let branch: String?
    let commitId: String?
    let workspaceId: String?
    let warning: String?
}

enum AidenGitProjection: Decodable, Equatable, Sendable {
    case review(AidenGitReview)
    case diff(AidenGitDiff)
    case branches(AidenGitBranches)
    case comparison(AidenGitComparison)
    case pushCapability(AidenGitPushCapability)
    case worktrees(AidenGitWorktrees)
    case mutation(AidenGitMutation)

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "review": self = .review(try AidenGitReview(from: decoder))
        case "diff": self = .diff(try AidenGitDiff(from: decoder))
        case "branches": self = .branches(try AidenGitBranches(from: decoder))
        case "comparison": self = .comparison(try AidenGitComparison(from: decoder))
        case "push-capability": self = .pushCapability(try AidenGitPushCapability(from: decoder))
        case "worktrees": self = .worktrees(try AidenGitWorktrees(from: decoder))
        case "mutation": self = .mutation(try AidenGitMutation(from: decoder))
        default: throw AidenRemoteClientError.invalidResponse
        }
    }
}

enum AidenGitOperationStatus: String, Codable, Sendable {
    case snapshot, accepted, running, succeeded, failed, conflict
}

struct AidenGitResult: Decodable, Equatable, Sendable {
    let operationId: String
    let status: AidenGitOperationStatus
    let snapshotId: String?
    let capability: AidenGitCapability?
    let result: AidenGitProjection?
}

struct AidenGitDiffRequest: Encodable { let snapshotId: String; let fileId: String }
struct AidenGitCreateBranchRequest: Encodable {
    let name: String
    let startPoint: String
    let confirmedForeground = true
}
struct AidenGitCheckoutRequest: Encodable {
    let branch: String
    let snapshotId: String
    let confirmedForeground = true
}
struct AidenGitCommitRequest: Encodable {
    let snapshotId: String
    let message: String
    let scope: String
    let confirmedForeground = true
}
struct AidenGitPushRequest: Encodable {
    let snapshotId: String
    let remote: String
    let branch: String
    let confirmedForeground = true
}
struct AidenGitCompareRequest: Encodable { let baseRef: String }
struct AidenGitComparisonDiffRequest: Encodable { let comparisonId: String; let fileId: String }
struct AidenGitCreateWorktreeRequest: Encodable {
    let branch: String
    let name: String
    let confirmedForeground = true
}
struct AidenForegroundConfirmation: Encodable { let confirmedForeground = true }
struct AidenWorkspaceFileWriteRequest: Encodable { let content: String; let expectedVersion: String }

enum AidenWorkspaceEnvironmentValidation {
    static func opaqueFileID(_ value: String) -> Bool {
        value.range(of: #"^file_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
    }

    static func safeDisplayPath(_ value: String) -> Bool {
        !value.isEmpty && !value.hasPrefix("/") && !value.split(separator: "/", omittingEmptySubsequences: false).contains("..")
    }

    static func validated(_ index: AidenWorkspaceFileIndex) throws -> AidenWorkspaceFileIndex {
        guard index.maxEntries == 4_000,
              index.maxDepth == 20,
              index.entries.count <= index.maxEntries,
              index.entries.allSatisfy({ entry in
                  opaqueFileID(entry.id) && safeDisplayPath(entry.displayPath) && !entry.name.isEmpty
              }) else {
            throw AidenRemoteClientError.invalidResponse
        }
        return index
    }

    static func validated(_ document: AidenWorkspaceFileDocument, expectedID: String) throws -> AidenWorkspaceFileDocument {
        guard document.id == expectedID,
              opaqueFileID(document.id),
              safeDisplayPath(document.displayPath),
              !document.version.isEmpty,
              !document.truncated else {
            throw AidenRemoteClientError.invalidResponse
        }
        return document
    }

    static func validated(_ git: AidenGitResult) throws -> AidenGitResult {
        guard git.operationId.hasPrefix("op_"), git.operationId.count <= 128 else {
            throw AidenRemoteClientError.invalidResponse
        }
        let validFiles: ([AidenGitFile]) -> Bool = { files in
            files.count <= 4_000 && files.allSatisfy {
                opaqueFileID($0.id) && safeDisplayPath($0.displayPath)
            }
        }
        switch git.result {
        case .review(let review):
            guard git.snapshotId != nil, validFiles(review.files), review.uncommitted >= 0 else {
                throw AidenRemoteClientError.invalidResponse
            }
        case .diff(let diff):
            guard git.snapshotId != nil, safeDisplayPath(diff.displayPath), diff.diff.count <= 2_000_000 else {
                throw AidenRemoteClientError.invalidResponse
            }
        case .branches:
            guard git.snapshotId != nil else { throw AidenRemoteClientError.invalidResponse }
        case .comparison(let comparison):
            guard git.snapshotId == comparison.comparisonId, validFiles(comparison.files) else {
                throw AidenRemoteClientError.invalidResponse
            }
        case .pushCapability:
            guard git.snapshotId != nil else { throw AidenRemoteClientError.invalidResponse }
        case .worktrees(let worktrees):
            guard worktrees.worktrees.allSatisfy({ !$0.id.isEmpty && !$0.name.isEmpty && !$0.branch.isEmpty }) else {
                throw AidenRemoteClientError.invalidResponse
            }
        case .mutation, .none:
            break
        }
        return git
    }
}

struct AidenWorkspaceSubagentRun: Decodable, Identifiable, Equatable, Sendable {
    enum Role: String, Decodable, Sendable { case scout, planner, reviewer }
    enum State: String, Decodable, Sendable {
        case queued, starting, running, completed, failed, timed_out, interrupted, needs_attention, stopped, unknown
        var title: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }
    }
    let id: String
    let label: String
    let role: Role
    let state: State
    let revision: Int64
    let startedAt: Int64
    let updatedAt: Int64

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: AidenSubagentCodingKey.self)
        try values.requireExactly(["id", "label", "role", "state", "revision", "startedAt", "updatedAt"])
        id = try values.decode(String.self, forKey: .init("id"))
        label = try values.decode(String.self, forKey: .init("label"))
        role = try values.decode(Role.self, forKey: .init("role"))
        state = try values.decode(State.self, forKey: .init("state"))
        revision = try values.decode(Int64.self, forKey: .init("revision"))
        startedAt = try values.decode(Int64.self, forKey: .init("startedAt"))
        updatedAt = try values.decode(Int64.self, forKey: .init("updatedAt"))
        guard id.range(of: "^run_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              label.unicodeScalars.count <= 80,
              !label.unicodeScalars.contains(where: { $0.value <= 31 || $0.value == 127 }),
              revision > 0, revision <= 9_007_199_254_740_991,
              startedAt >= 0, startedAt <= 9_007_199_254_740_991,
              updatedAt >= startedAt, updatedAt <= 9_007_199_254_740_991 else {
            throw AidenRemoteClientError.invalidResponse
        }
    }
}

struct AidenWorkspaceSubagentPage: Decodable, Equatable, Sendable {
    let version: Int
    let workspaceId: String
    let chatId: String
    let runs: [AidenWorkspaceSubagentRun]
    let truncated: Bool

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: AidenSubagentCodingKey.self)
        try values.requireExactly(["version", "workspaceId", "chatId", "runs", "truncated"])
        version = try values.decode(Int.self, forKey: .init("version"))
        workspaceId = try values.decode(String.self, forKey: .init("workspaceId"))
        chatId = try values.decode(String.self, forKey: .init("chatId"))
        runs = try values.decode([AidenWorkspaceSubagentRun].self, forKey: .init("runs"))
        truncated = try values.decode(Bool.self, forKey: .init("truncated"))
        guard version == 1,
              workspaceId.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil,
              chatId.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil,
              runs.count <= 100, Set(runs.map(\.id)).count == runs.count else {
            throw AidenRemoteClientError.invalidResponse
        }
    }

    func validated(workspaceID: String, chatID: String) throws -> Self {
        guard workspaceId == workspaceID, chatId == chatID else { throw AidenRemoteClientError.invalidResponse }
        return self
    }
}

private struct AidenSubagentCodingKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private extension KeyedDecodingContainer where Key == AidenSubagentCodingKey {
    func requireExactly(_ keys: Set<String>) throws {
        guard Set(allKeys.map(\.stringValue)) == keys else { throw AidenRemoteClientError.invalidResponse }
    }
}

/// Pure address policy: hints never initiate a request.
enum AidenNativeBrowserAddress {
    static func url(_ input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 8192, !text.contains("\\"),
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let parts = URLComponents(string: text),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
        return parts.url
    }

    static func developmentHost(_ input: String?) -> String? {
        guard let input, input == input.lowercased(), input.utf8.count <= 253 else { return nil }
        let octets = input.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, let numbers = Optional(octets.compactMap { Int($0) }), numbers.count == 4,
           zip(octets, numbers).allSatisfy({ String($1) == $0 && (0...255).contains($1) }),
           numbers[0] == 100, (64...127).contains(numbers[1]) { return input }
        guard input.hasSuffix(".ts.net"), octets.count >= 3,
              octets.allSatisfy({ label in
                  !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                  && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
              }) else { return nil }
        return input
    }

    /// Only an explicitly tapped HTTP Tailscale website link belongs to the development pane.
    static func isDevelopmentLink(_ candidate: URL) -> Bool {
        guard let validated = url(candidate.absoluteString), validated.scheme?.lowercased() == "http" else { return false }
        return developmentHost(validated.host) != nil
    }

    static func resolvedURL(_ input: String, developmentHost: String?) -> URL? {
        guard let url = url(input) else { return nil }
        let host = url.host?.lowercased() ?? ""
        if host == "localhost" || host.hasSuffix(".localhost") || host == "0.0.0.0"
            || host == "[::1]" || host == "::1" || host.hasPrefix("127.") {
            guard let host = Self.developmentHost(developmentHost),
                  var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            parts.host = host
            return parts.url
        }
        return url
    }

    static func developmentURL(host: String?, port: String) -> URL? {
        guard let host = developmentHost(host), let value = Int(port), String(value) == port,
              (1...65535).contains(value) else { return nil }
        return url("http://\(host):\(value)/")
    }
}
