import Foundation

// Modified for Aiden: local-only loading, bounded protocol and validation.
// See THIRD_PARTY_NOTICES.md for the upstream Apache-2.0 license.

// Error surface ported from FluidAudio's Apache-2.0-licensed
// `Sources/FluidAudio/Decision/CuaS1Forms/CuaS1FormsTypes.swift`
// (pinned revision 87a39dfe4068fef0f1c69bfe704b2b3ef4fbc5bc), extended with
// protocol-level cases for Aiden's helper transport.
/// Errors from form-option encoding, model loading, prediction validation, or protocol handling.
public enum CuaS1FormsError: Error, LocalizedError, Sendable, Equatable {
    /// The model requires a nonempty description of the task and UI element.
    case emptyContext
    /// A request must contain between two and the model's maximum number of options.
    case invalidOptionCount(Int)
    /// The option at this zero-based index is empty.
    case emptyOption(Int)
    /// The model does not have the supported CUA-S1-FORMS tensor interface.
    case invalidModel(String)
    /// The model returned invalid logits or probabilities.
    case invalidOutput(String)
    /// The request envelope or fields failed protocol validation.
    case invalidRequest(String)
    /// The request's protocol version does not match this helper build.
    case unsupportedProtocol(Int)
    /// The helper was asked to score before a model was loaded.
    case modelNotLoaded
    /// The operation was cancelled by the host.
    case cancelled
    /// The local model artifact could not be compiled or loaded.
    case artifactUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .emptyContext:
            return "CUA-S1-FORMS requires a nonempty context."
        case .invalidOptionCount(let count):
            return "CUA-S1-FORMS requires 2–32 options; received \(count)."
        case .emptyOption(let index):
            return "CUA-S1-FORMS option \(index) is empty."
        case .invalidModel(let reason):
            return "Invalid CUA-S1-FORMS model: \(reason)"
        case .invalidOutput(let reason):
            return "Invalid CUA-S1-FORMS output: \(reason)"
        case .invalidRequest(let reason):
            return "Invalid CUA-S1-FORMS request: \(reason)"
        case .unsupportedProtocol(let version):
            return "Unsupported CUA-S1-FORMS protocol version \(version)."
        case .modelNotLoaded:
            return "CUA-S1-FORMS model is not loaded."
        case .cancelled:
            return "The CUA-S1-FORMS request was cancelled."
        case .artifactUnavailable(let reason):
            return "CUA-S1-FORMS artifact is unavailable: \(reason)"
        }
    }
}

/// Scores for the supplied options, in their original order.
///
/// Probabilities are scores, not guarantees of correctness. This result
/// describes one form decision; it does not execute or authorize a GUI action.
public struct CuaS1FormsResult: Sendable {
    /// Zero-based index of the highest-probability supplied option.
    public let selectedIndex: Int
    /// The original, untruncated option string at `selectedIndex`.
    public let selectedOption: String
    /// Stable softmax of the emitted logits, computed with Double arithmetic and returned as Float.
    /// One probability per supplied option; padding is omitted.
    public let probabilities: [Float]
    /// Unmodified model softmax output for the supplied options, excluding padding.
    /// FP16 rounding can leave its sum outside one; retained for conversion comparisons.
    public let rawProbabilities: [Float]
    /// One raw score per supplied option; padding is omitted.
    public let logits: [Float]
    /// Whether context encoding exceeded the model's 224-byte input limit.
    public let contextWasTruncated: Bool
    /// Indices of options whose encoding exceeded the model's 96-byte input limit.
    public let truncatedOptionIndices: [Int]
}
