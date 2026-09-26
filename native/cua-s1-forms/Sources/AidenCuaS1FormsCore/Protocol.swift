import Foundation

/// Newline-delimited JSON protocol between Electron main and the helper process.
/// Every message is a single line of UTF-8 JSON bounded by `maximumRequestBytes`
/// (requests) and `maximumResponseBytes` (responses).
public let cuaS1FormsProtocolVersion = 1

public let cuaS1FormsMaximumRequestBytes = 262_144
public let cuaS1FormsMaximumResponseBytes = 262_144

/// Maximum UTF-8 bytes accepted for a context or option string at the transport
/// layer. Encoding still applies the model's 224/96-byte truncation bounds; this
/// bound only caps memory and abuse surface.
public let cuaS1FormsMaximumTextBytes = 8_192
public let cuaS1FormsMaximumRequestIDBytes = 128

public enum CuaS1FormsMethod: String, Codable, Sendable {
    /// Load (compiling when required) and validate a local model artifact.
    case load
    /// Score one context against 2–32 options using the loaded model.
    case score
    /// Compile a `.mlpackage` once and move the compiled bundle to a directory.
    case compile
    /// Flush state and exit cleanly.
    case shutdown
}

public struct CuaS1FormsRequest: Codable, Sendable, Equatable {
    public let version: Int
    public let id: String
    public let method: CuaS1FormsMethod
    /// `load`: local `.mlpackage`/`.mlmodelc` path. `compile`: `.mlpackage` path.
    public let modelPath: String?
    /// `compile`: directory that receives the compiled `.mlmodelc`.
    public let destinationDirectory: String?
    /// `score`: nonempty context string.
    public let context: String?
    /// `score`: 2–32 nonempty option strings.
    public let options: [String]?

    public init(
        version: Int,
        id: String,
        method: CuaS1FormsMethod,
        modelPath: String? = nil,
        destinationDirectory: String? = nil,
        context: String? = nil,
        options: [String]? = nil
    ) {
        self.version = version
        self.id = id
        self.method = method
        self.modelPath = modelPath
        self.destinationDirectory = destinationDirectory
        self.context = context
        self.options = options
    }

    /// Validate transport bounds before dispatch. `fail` throws for callers that
    /// cannot express failures in-band (e.g. malformed JSON never reaches here).
    public func validated() throws -> CuaS1FormsRequest {
        guard version == cuaS1FormsProtocolVersion else {
            throw CuaS1FormsError.unsupportedProtocol(version)
        }
        guard !id.isEmpty, id.utf8.count <= cuaS1FormsMaximumRequestIDBytes else {
            throw CuaS1FormsError.invalidRequest("Request id is missing or too large.")
        }
        switch method {
        case .load:
            try requireBoundedPath(modelPath, field: "modelPath")
        case .compile:
            try requireBoundedPath(modelPath, field: "modelPath")
            try requireBoundedPath(destinationDirectory, field: "destinationDirectory")
        case .score:
            guard let context, !context.isEmpty else {
                throw CuaS1FormsError.emptyContext
            }
            guard context.utf8.count <= cuaS1FormsMaximumTextBytes else {
                throw CuaS1FormsError.invalidRequest("context exceeds the transport limit.")
            }
            guard let options, (2...CuaS1FormsInput.maximumOptions).contains(options.count)
            else {
                throw CuaS1FormsError.invalidOptionCount(options?.count ?? 0)
            }
            for (index, option) in options.enumerated() {
                guard !option.isEmpty else { throw CuaS1FormsError.emptyOption(index) }
                guard option.utf8.count <= cuaS1FormsMaximumTextBytes else {
                    throw CuaS1FormsError.invalidRequest("option \(index) exceeds the transport limit.")
                }
            }
        case .shutdown:
            break
        }
        return self
    }

    private func requireBoundedPath(_ value: String?, field: String) throws {
        guard let value, !value.isEmpty, value.utf8.count <= cuaS1FormsMaximumTextBytes else {
            throw CuaS1FormsError.invalidRequest("\(field) is missing or too large.")
        }
        // Only absolute local filesystem paths may name artifacts.
        guard value.hasPrefix("/"), !value.contains("\0") else {
            throw CuaS1FormsError.invalidRequest("\(field) must be an absolute path.")
        }
    }
}

public struct CuaS1FormsScoreResult: Codable, Sendable, Equatable {
    public let selectedIndex: Int
    public let probabilities: [Float]
    public let rawProbabilities: [Float]
    public let logits: [Float]
    public let contextWasTruncated: Bool
    public let truncatedOptionIndices: [Int]
}

public struct CuaS1FormsLoadResult: Codable, Sendable, Equatable {
    /// Canonical path of the loaded artifact as seen by the helper.
    public let loadedPath: String
}

public struct CuaS1FormsCompileResult: Codable, Sendable, Equatable {
    /// Location of the compiled `.mlmodelc` inside the requested directory.
    public let compiledPath: String
}

public enum CuaS1FormsErrorCode: String, Codable, Sendable, Equatable {
    case invalidRequest = "invalid_request"
    case unsupportedProtocol = "unsupported_protocol"
    case modelNotLoaded = "model_not_loaded"
    case invalidModel = "invalid_model"
    case invalidOutput = "invalid_output"
    case artifactUnavailable = "artifact_unavailable"
    case cancelled
    case internalFailure = "internal_failure"
}

public struct CuaS1FormsResponseError: Codable, Sendable, Equatable {
    public let code: CuaS1FormsErrorCode
    public let message: String

    public init(code: CuaS1FormsErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

/// Discriminated result payload — exactly one field is set on success.
public struct CuaS1FormsResultPayload: Codable, Sendable, Equatable {
    public let load: CuaS1FormsLoadResult?
    public let compile: CuaS1FormsCompileResult?
    public let score: CuaS1FormsScoreResult?

    public init(
        load: CuaS1FormsLoadResult? = nil,
        compile: CuaS1FormsCompileResult? = nil,
        score: CuaS1FormsScoreResult? = nil
    ) {
        self.load = load
        self.compile = compile
        self.score = score
    }
}

public struct CuaS1FormsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let id: String
    public let ok: Bool
    public let result: CuaS1FormsResultPayload?
    public let error: CuaS1FormsResponseError?

    public static func success(id: String, result: CuaS1FormsResultPayload) -> Self {
        Self(version: cuaS1FormsProtocolVersion, id: id, ok: true, result: result, error: nil)
    }

    public static func failure(id: String, code: CuaS1FormsErrorCode, message: String) -> Self {
        Self(
            version: cuaS1FormsProtocolVersion,
            id: id,
            ok: false,
            result: nil,
            error: CuaS1FormsResponseError(code: code, message: message)
        )
    }

    public static func failure(id: String, _ error: CuaS1FormsError) -> Self {
        let code: CuaS1FormsErrorCode
        switch error {
        case .emptyContext, .invalidOptionCount, .emptyOption, .invalidRequest:
            code = .invalidRequest
        case .unsupportedProtocol:
            code = .unsupportedProtocol
        case .modelNotLoaded:
            code = .modelNotLoaded
        case .invalidModel:
            code = .invalidModel
        case .invalidOutput:
            code = .invalidOutput
        case .cancelled:
            code = .cancelled
        case .artifactUnavailable:
            code = .artifactUnavailable
        }
        let message = error.errorDescription ?? "The native form-fill helper failed."
        return .failure(id: id, code: code, message: String(message.prefix(1_000)))
    }
}
