@preconcurrency import CoreML
import Foundation

// Modified for Aiden: local-only loading, bounded protocol and validation.
// See THIRD_PARTY_NOTICES.md for the upstream Apache-2.0 license.

// Model loading and scoring adapted from FluidAudio's Apache-2.0-licensed
// `Sources/FluidAudio/Decision/CuaS1Forms/CuaS1FormsManager.swift` and
// `CuaS1FormsPackage.swift` (pinned revision
// 87a39dfe4068fef0f1c69bfe704b2b3ef4fbc5bc). Aiden's variant loads only an
// already-installed local artifact supplied by the host; it never downloads.
/// On-device CUA-S1-FORMS decision scoring for supplied document entities and form actions.
public actor CuaS1FormsScorer {
    public static let contextByteLimit = CuaS1FormsInput.contextByteLimit
    public static let optionByteLimit = CuaS1FormsInput.optionByteLimit
    public static let maximumOptions = CuaS1FormsInput.maximumOptions

    private let model: MLModel

    /// Initialize with an already loaded model after validating its tensor interface.
    public init(model: MLModel) throws {
        try Self.validateModel(model.modelDescription)
        self.model = model
    }

    /// Load a local `.mlpackage` or `.mlmodelc`, compiling the package locally when necessary.
    /// This path performs no network access and no artifact mutation.
    public static func load(
        from modelURL: URL,
        computeUnits: MLComputeUnits = .cpuAndNeuralEngine
    ) async throws -> CuaS1FormsScorer {
        try Task.checkCancellation()
        guard modelURL.isFileURL else {
            throw CuaS1FormsError.invalidModel("A local file URL is required")
        }
        let compiledURL: URL
        switch modelURL.pathExtension {
        case "mlpackage":
            let package = try CuaS1FormsPackage.prepare(modelURL)
            defer { package.cleanup() }
            compiledURL = try await MLModel.compileModel(at: package.url)
        case "mlmodelc":
            compiledURL = modelURL
        default:
            throw CuaS1FormsError.invalidModel("Expected a .mlpackage or .mlmodelc URL")
        }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = computeUnits
        let model = try await MLModel.load(contentsOf: compiledURL, configuration: configuration)
        return try CuaS1FormsScorer(model: model)
    }

    /// Compile a `.mlpackage` once and move the compiled bundle into `destinationDirectory`.
    /// Returns the compiled bundle URL. Used by the install-time prepare step only.
    public static func compile(
        packageAt modelURL: URL,
        into destinationDirectory: URL
    ) async throws -> URL {
        try Task.checkCancellation()
        guard modelURL.isFileURL, modelURL.pathExtension == "mlpackage" else {
            throw CuaS1FormsError.invalidModel("compile requires a local .mlpackage URL")
        }
        let package = try CuaS1FormsPackage.prepare(modelURL)
        defer { package.cleanup() }
        let compiled = try await MLModel.compileModel(at: package.url)
        let destination = destinationDirectory.appendingPathComponent(
            compiled.lastPathComponent,
            isDirectory: true
        )
        let manager = FileManager.default
        try manager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
        if manager.fileExists(atPath: destination.path) {
            try manager.removeItem(at: destination)
        }
        try manager.moveItem(at: compiled, to: destination)
        return destination
    }

    /// Score 2–32 nonempty options against one nonempty context.
    ///
    /// Text is truncated by UTF-8 bytes exactly as in the upstream checkpoint. The result
    /// reports any truncation; options beyond the supported capacity are rejected, not dropped.
    /// Probabilities use a stable host softmax of the model logits; the model's own softmax
    /// output is retained in `rawProbabilities` for conversion comparisons.
    public func score(context: String, options: [String]) throws -> CuaS1FormsResult {
        try Task.checkCancellation()
        let encoded = try CuaS1FormsInput(context: context, options: options)
        return try autoreleasepool {
            let features = try MLDictionaryFeatureProvider(dictionary: [
                "context_ids": makeArray(encoded.contextIDs, shape: [1, Self.contextByteLimit]),
                "option_ids": makeArray(
                    encoded.optionIDs,
                    shape: [1, Self.maximumOptions, Self.optionByteLimit]
                ),
                "option_mask": makeArray(encoded.optionMask, shape: [1, Self.maximumOptions]),
            ])
            let prediction = try model.prediction(from: features)
            let output = try CuaS1FormsOutput(
                logits: try readOutput("logits", from: prediction),
                rawProbabilities: try readOutput("probabilities", from: prediction),
                optionCount: options.count
            )
            return CuaS1FormsResult(
                selectedIndex: output.selectedIndex,
                selectedOption: options[output.selectedIndex],
                probabilities: output.probabilities,
                rawProbabilities: output.rawProbabilities,
                logits: output.logits,
                contextWasTruncated: encoded.contextWasTruncated,
                truncatedOptionIndices: encoded.truncatedOptionIndices
            )
        }
    }

    private func makeArray(_ values: [Int32], shape: [Int]) throws -> MLMultiArray {
        let array = try MLMultiArray(
            shape: shape.map { NSNumber(value: $0) },
            dataType: .int32
        )
        let pointer = array.dataPointer.assumingMemoryBound(to: Int32.self)
        for (index, value) in values.enumerated() { pointer[index] = value }
        return array
    }

    private func readOutput(_ name: String, from output: MLFeatureProvider) throws -> [Float] {
        guard let array = output.featureValue(for: name)?.multiArrayValue,
            array.shape.map({ $0.intValue }) == [1, Self.maximumOptions],
            array.dataType == .float32
        else {
            throw CuaS1FormsError.invalidOutput("\(name) must be float32 [1, 32]")
        }
        return (0..<Self.maximumOptions).map { array[$0].floatValue }
    }

    private static func validateModel(_ description: MLModelDescription) throws {
        let inputs = description.inputDescriptionsByName
        let expected = [
            "context_ids": [1, contextByteLimit],
            "option_ids": [1, maximumOptions, optionByteLimit],
            "option_mask": [1, maximumOptions],
        ]
        guard Set(inputs.keys) == Set(expected.keys) else {
            throw CuaS1FormsError.invalidModel("Unexpected input names")
        }
        for (name, shape) in expected {
            guard let constraint = inputs[name]?.multiArrayConstraint,
                constraint.dataType == .int32,
                constraint.shape.map({ $0.intValue }) == shape
            else {
                throw CuaS1FormsError.invalidModel("Unexpected shape or type for \(name)")
            }
        }
        for name in ["logits", "probabilities"] {
            guard
                let constraint = description.outputDescriptionsByName[name]?
                    .multiArrayConstraint,
                constraint.dataType == .float32,
                constraint.shape.map({ $0.intValue }) == [1, maximumOptions]
            else {
                throw CuaS1FormsError.invalidModel("Unexpected shape or type for \(name)")
            }
        }
    }
}

/// Core ML compilation relocates package files, which can break relative links inside
/// a staged artifact. Copy-resolving before compile keeps the verified package intact.
struct CuaS1FormsPackage: Sendable {
    let url: URL
    private let temporaryDirectory: URL?

    static func prepare(_ modelURL: URL) throws -> Self {
        let source = modelURL.resolvingSymlinksInPath()
        let manager = FileManager.default
        let entries = manager.enumerator(
            at: source,
            includingPropertiesForKeys: [.isSymbolicLinkKey]
        )
        var containsLinks = false
        while let entry = entries?.nextObject() as? URL {
            if try entry.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
                containsLinks = true
                break
            }
        }
        guard containsLinks else { return Self(url: source, temporaryDirectory: nil) }

        let temporary = manager.temporaryDirectory.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true
        )
        let destination = temporary.appendingPathComponent(
            modelURL.lastPathComponent,
            isDirectory: true
        )
        try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
        do {
            try copyResolvingLinks(from: source, to: destination, ancestors: [])
            return Self(url: destination, temporaryDirectory: temporary)
        } catch {
            try? manager.removeItem(at: temporary)
            throw error
        }
    }

    func cleanup() {
        guard let temporaryDirectory else { return }
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    private static func copyResolvingLinks(
        from source: URL,
        to destination: URL,
        ancestors: Set<String>
    ) throws {
        let resolved = source.resolvingSymlinksInPath()
        let manager = FileManager.default
        guard try resolved.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            try manager.copyItem(at: resolved, to: destination)
            return
        }
        guard !ancestors.contains(resolved.path) else {
            throw CuaS1FormsError.invalidModel("Package contains a symbolic-link cycle")
        }
        var nextAncestors = ancestors
        nextAncestors.insert(resolved.path)
        try manager.createDirectory(at: destination, withIntermediateDirectories: false)
        for child in try manager.contentsOfDirectory(
            at: resolved,
            includingPropertiesForKeys: nil
        ) {
            try copyResolvingLinks(
                from: child,
                to: destination.appendingPathComponent(child.lastPathComponent),
                ancestors: nextAncestors
            )
        }
    }
}
