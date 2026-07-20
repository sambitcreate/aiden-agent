import Foundation
import FoundationModels
import Testing
@testable import AidenFoundationModelsCore

@Test func validatesTitlePromptsAndProtocolVersion() throws {
    let request = FoundationModelsRequest(
        version: foundationModelsProtocolVersion,
        method: .generateTitle,
        prompt: "  Name this conversation  "
    )
    #expect(try request.validatedPrompt() == "Name this conversation")

    let wrongVersion = FoundationModelsRequest(version: 99, method: .generateTitle, prompt: "x")
    #expect(throws: FoundationModelsHelperError.self) {
        try wrongVersion.validatedPrompt()
    }
}

@Test func rejectsMissingAndOversizedPrompts() {
    let missing = FoundationModelsRequest(
        version: foundationModelsProtocolVersion,
        method: .generateTitle
    )
    #expect(throws: FoundationModelsHelperError.self) {
        try missing.validatedPrompt()
    }

    let large = FoundationModelsRequest(
        version: foundationModelsProtocolVersion,
        method: .generateTitle,
        prompt: String(repeating: "a", count: 64)
    )
    #expect(throws: FoundationModelsHelperError.self) {
        try large.validatedPrompt(maximumUTF8Bytes: 32)
    }
}

@Test func mapsEveryKnownAvailabilityReason() {
    #expect(mapUnavailableReason(.deviceNotEligible) == .deviceNotEligible)
    #expect(mapUnavailableReason(.appleIntelligenceNotEnabled) == .appleIntelligenceDisabled)
    #expect(mapUnavailableReason(.modelNotReady) == .modelPreparing)
}

@Test func responseEnvelopeRoundTripsWithoutSecrets() throws {
    let response = FoundationModelsResponse.success(
        FoundationModelsResult(state: .ready, title: "Native Chat Titles")
    )
    let data = try JSONEncoder().encode(response)
    let decoded = try JSONDecoder().decode(FoundationModelsResponse.self, from: data)
    #expect(decoded == response)
}
