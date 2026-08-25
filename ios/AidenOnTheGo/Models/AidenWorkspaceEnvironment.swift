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
