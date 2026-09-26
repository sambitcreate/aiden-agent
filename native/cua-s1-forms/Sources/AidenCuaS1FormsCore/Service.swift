import Foundation

/// Stateful request dispatcher for the helper process. Keeps the loaded model
/// warm across `score` requests for the lifetime of the bounded operation.
public actor CuaS1FormsService {
    private var scorer: CuaS1FormsScorer?

    public init() {}

    /// Whether a `shutdown` request was received and processed.
    public private(set) var shutdownRequested = false

    /// Handle one already-validated request, returning the in-band response.
    public func handle(_ request: CuaS1FormsRequest) async -> CuaS1FormsResponse {
        do {
            let validated = try request.validated()
            switch validated.method {
            case .load:
                let modelURL = URL(fileURLWithPath: validated.modelPath!)
                scorer = try await CuaS1FormsScorer.load(from: modelURL)
                return .success(
                    id: validated.id,
                    result: CuaS1FormsResultPayload(
                        load: CuaS1FormsLoadResult(loadedPath: modelURL.path)
                    )
                )
            case .compile:
                let modelURL = URL(fileURLWithPath: validated.modelPath!)
                let destination = URL(fileURLWithPath: validated.destinationDirectory!)
                let compiled = try await CuaS1FormsScorer.compile(
                    packageAt: modelURL,
                    into: destination
                )
                return .success(
                    id: validated.id,
                    result: CuaS1FormsResultPayload(
                        compile: CuaS1FormsCompileResult(compiledPath: compiled.path)
                    )
                )
            case .score:
                guard let scorer else {
                    throw CuaS1FormsError.modelNotLoaded
                }
                let result = try await scorer.score(
                    context: validated.context!,
                    options: validated.options!
                )
                return .success(
                    id: validated.id,
                    result: CuaS1FormsResultPayload(
                        score: CuaS1FormsScoreResult(
                            selectedIndex: result.selectedIndex,
                            probabilities: result.probabilities,
                            rawProbabilities: result.rawProbabilities,
                            logits: result.logits,
                            contextWasTruncated: result.contextWasTruncated,
                            truncatedOptionIndices: result.truncatedOptionIndices
                        )
                    )
                )
            case .shutdown:
                scorer = nil
                shutdownRequested = true
                return .success(id: validated.id, result: CuaS1FormsResultPayload())
            }
        } catch let error as CuaS1FormsError {
            return .failure(id: request.id, error)
        } catch is CancellationError {
            return .failure(id: request.id, .cancelled)
        } catch {
            // Never echo arbitrary error text that could carry artifact content;
            // map to a coarse internal failure instead.
            return .failure(
                id: request.id,
                code: .internalFailure,
                message: "The native form-fill helper could not complete the request."
            )
        }
    }
}
