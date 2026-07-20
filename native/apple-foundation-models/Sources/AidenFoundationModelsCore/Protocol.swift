import Foundation

public let foundationModelsProtocolVersion = 1

public enum FoundationModelsMethod: String, Codable, Sendable {
    case availability
    case generateTitle
}

public struct FoundationModelsRequest: Codable, Sendable, Equatable {
    public let version: Int
    public let method: FoundationModelsMethod
    public let prompt: String?

    public init(version: Int, method: FoundationModelsMethod, prompt: String? = nil) {
        self.version = version
        self.method = method
        self.prompt = prompt
    }

    public func validatedPrompt(maximumUTF8Bytes: Int = 16_384) throws -> String {
        guard version == foundationModelsProtocolVersion else {
            throw FoundationModelsHelperError(
                code: .unsupportedProtocol,
                message: "Unsupported native helper protocol version."
            )
        }
        guard method == .generateTitle else {
            throw FoundationModelsHelperError(
                code: .invalidRequest,
                message: "This request does not generate a title."
            )
        }
        let value = (prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw FoundationModelsHelperError(code: .invalidRequest, message: "Missing title prompt.")
        }
        guard value.lengthOfBytes(using: .utf8) <= maximumUTF8Bytes else {
            throw FoundationModelsHelperError(code: .invalidRequest, message: "Title prompt is too large.")
        }
        return value
    }
}

public enum FoundationModelsAvailabilityState: String, Codable, Sendable, Equatable {
    case ready
    case deviceNotEligible = "device_not_eligible"
    case appleIntelligenceDisabled = "apple_intelligence_disabled"
    case modelPreparing = "model_preparing"
    case unavailable
}

public struct FoundationModelsResult: Codable, Sendable, Equatable {
    public let state: FoundationModelsAvailabilityState?
    public let title: String?

    public init(state: FoundationModelsAvailabilityState? = nil, title: String? = nil) {
        self.state = state
        self.title = title
    }
}

public enum FoundationModelsErrorCode: String, Codable, Sendable, Equatable {
    case invalidRequest = "invalid_request"
    case unsupportedProtocol = "unsupported_protocol"
    case modelUnavailable = "model_unavailable"
    case contextExceeded = "context_exceeded"
    case assetsUnavailable = "assets_unavailable"
    case guardrailViolation = "guardrail_violation"
    case unsupportedGuide = "unsupported_guide"
    case unsupportedLanguage = "unsupported_language"
    case decodingFailure = "decoding_failure"
    case rateLimited = "rate_limited"
    case concurrentRequest = "concurrent_request"
    case cancelled
    case refusal
    case internalFailure = "internal_failure"
}

public struct FoundationModelsResponseError: Codable, Sendable, Equatable {
    public let code: FoundationModelsErrorCode
    public let message: String
    public let retryable: Bool

    public init(code: FoundationModelsErrorCode, message: String, retryable: Bool) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}

public struct FoundationModelsResponse: Codable, Sendable, Equatable {
    public let version: Int
    public let ok: Bool
    public let result: FoundationModelsResult?
    public let error: FoundationModelsResponseError?

    public static func success(_ result: FoundationModelsResult) -> Self {
        Self(
            version: foundationModelsProtocolVersion,
            ok: true,
            result: result,
            error: nil
        )
    }

    public static func failure(_ error: FoundationModelsHelperError) -> Self {
        Self(
            version: foundationModelsProtocolVersion,
            ok: false,
            result: nil,
            error: FoundationModelsResponseError(
                code: error.code,
                message: error.message,
                retryable: error.retryable
            )
        )
    }
}

public struct FoundationModelsHelperError: Error, Sendable, Equatable {
    public let code: FoundationModelsErrorCode
    public let message: String
    public let retryable: Bool

    public init(code: FoundationModelsErrorCode, message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}
