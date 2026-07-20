import Foundation
import FoundationModels

@Generable
private struct GeneratedChatTitle: Sendable {
    @Guide(description: "A specific title of 3 to 8 words with no quotes, prefix, or ending punctuation")
    let title: String
}

public struct FoundationModelsTitleService: Sendable {
    public init() {}

    public func availability() -> FoundationModelsAvailabilityState {
        switch SystemLanguageModel.default.availability {
        case .available:
            return .ready
        case .unavailable(let reason):
            return mapUnavailableReason(reason)
        }
    }

    public func generateTitle(prompt: String) async throws -> String {
        let state = availability()
        guard state == .ready else {
            throw FoundationModelsHelperError(
                code: .modelUnavailable,
                message: availabilityMessage(for: state),
                retryable: state == .modelPreparing
            )
        }

        let session = LanguageModelSession(
            model: SystemLanguageModel.default,
            instructions: Instructions("""
            Write short, concrete titles for coding conversations.
            Use only facts present in the prompt. Never add a prefix or explanation.
            """)
        )

        do {
            let response = try await session.respond(
                to: Prompt(prompt),
                generating: GeneratedChatTitle.self,
                options: GenerationOptions(
                    sampling: .greedy,
                    temperature: 0.1,
                    maximumResponseTokens: 32
                )
            )
            let title = response.content.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else {
                throw FoundationModelsHelperError(
                    code: .decodingFailure,
                    message: "Foundation Models returned an empty title."
                )
            }
            return title
        } catch let error as FoundationModelsHelperError {
            throw error
        } catch let error as LanguageModelSession.GenerationError {
            throw mapGenerationError(error)
        } catch {
            throw FoundationModelsHelperError(
                code: .internalFailure,
                message: "Foundation Models could not generate a title."
            )
        }
    }
}

public func mapUnavailableReason(
    _ reason: SystemLanguageModel.Availability.UnavailableReason
) -> FoundationModelsAvailabilityState {
    switch reason {
    case .deviceNotEligible:
        return .deviceNotEligible
    case .appleIntelligenceNotEnabled:
        return .appleIntelligenceDisabled
    case .modelNotReady:
        return .modelPreparing
    @unknown default:
        return .unavailable
    }
}

public func availabilityMessage(for state: FoundationModelsAvailabilityState) -> String {
    switch state {
    case .ready:
        return "Apple Foundation Models are ready."
    case .deviceNotEligible:
        return "This Mac does not support Apple Intelligence."
    case .appleIntelligenceDisabled:
        return "Apple Intelligence is not enabled."
    case .modelPreparing:
        return "Apple Foundation Models are still downloading or preparing."
    case .unavailable:
        return "Apple Foundation Models are unavailable."
    }
}

private func mapGenerationError(
    _ error: LanguageModelSession.GenerationError
) -> FoundationModelsHelperError {
    switch error {
    case .exceededContextWindowSize:
        return FoundationModelsHelperError(
            code: .contextExceeded,
            message: "The title prompt exceeded the Foundation Models context window."
        )
    case .assetsUnavailable:
        return FoundationModelsHelperError(
            code: .assetsUnavailable,
            message: "Foundation Models assets are temporarily unavailable.",
            retryable: true
        )
    case .guardrailViolation:
        return FoundationModelsHelperError(
            code: .guardrailViolation,
            message: "The title request was blocked by Foundation Models guardrails."
        )
    case .unsupportedGuide:
        return FoundationModelsHelperError(
            code: .unsupportedGuide,
            message: "The installed Foundation Models version does not support the title schema."
        )
    case .unsupportedLanguageOrLocale:
        return FoundationModelsHelperError(
            code: .unsupportedLanguage,
            message: "The title language is not supported by Foundation Models."
        )
    case .decodingFailure:
        return FoundationModelsHelperError(
            code: .decodingFailure,
            message: "Foundation Models could not produce the requested title structure."
        )
    case .rateLimited:
        return FoundationModelsHelperError(
            code: .rateLimited,
            message: "Foundation Models are temporarily rate limited.",
            retryable: true
        )
    case .concurrentRequests:
        return FoundationModelsHelperError(
            code: .concurrentRequest,
            message: "Foundation Models are already handling another request.",
            retryable: true
        )
    case .refusal:
        return FoundationModelsHelperError(
            code: .refusal,
            message: "Foundation Models declined to generate this title."
        )
    @unknown default:
        return FoundationModelsHelperError(
            code: .internalFailure,
            message: "Foundation Models could not generate a title."
        )
    }
}
