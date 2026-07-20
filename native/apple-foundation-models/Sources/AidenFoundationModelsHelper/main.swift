import AidenFoundationModelsCore
import Foundation

@main
struct AidenFoundationModelsHelper {
    private static let maximumRequestBytes = 20_000

    private static func readRequest(from requestURL: URL?) throws -> Data {
        let handle: FileHandle
        let shouldClose: Bool
        if let requestURL {
            handle = try FileHandle(forReadingFrom: requestURL)
            shouldClose = true
        } else {
            handle = FileHandle.standardInput
            shouldClose = false
        }
        defer {
            if shouldClose { try? handle.close() }
            if let requestURL { try? FileManager.default.removeItem(at: requestURL) }
        }
        return try handle.read(upToCount: maximumRequestBytes + 1) ?? Data()
    }

    static func main() async {
        let arguments = CommandLine.arguments
        let requestURL: URL?
        let responseURL: URL?
        let processURL: URL?
        let cancellationURL: URL?
        if arguments.count == 9,
           arguments[1] == "--request-file",
           arguments[3] == "--response-file",
           arguments[5] == "--process-file",
           arguments[7] == "--cancellation-file" {
            requestURL = URL(fileURLWithPath: arguments[2])
            responseURL = URL(fileURLWithPath: arguments[4])
            processURL = URL(fileURLWithPath: arguments[6])
            cancellationURL = URL(fileURLWithPath: arguments[8])
        } else {
            requestURL = nil
            responseURL = nil
            processURL = nil
            cancellationURL = nil
        }

        if let processURL {
            try? Data(String(ProcessInfo.processInfo.processIdentifier).utf8)
                .write(to: processURL, options: .atomic)
        }
        defer {
            if let processURL { try? FileManager.default.removeItem(at: processURL) }
        }

        let response: FoundationModelsResponse
        do {
            let data = try readRequest(from: requestURL)
            guard data.count <= maximumRequestBytes else {
                throw FoundationModelsHelperError(
                    code: .invalidRequest,
                    message: "Native helper request is too large."
                )
            }
            let request = try JSONDecoder().decode(FoundationModelsRequest.self, from: data)
            guard request.version == foundationModelsProtocolVersion else {
                throw FoundationModelsHelperError(
                    code: .unsupportedProtocol,
                    message: "Unsupported native helper protocol version."
                )
            }
            if let cancellationURL, FileManager.default.fileExists(atPath: cancellationURL.path) {
                throw FoundationModelsHelperError(
                    code: .cancelled,
                    message: "The native title request was cancelled."
                )
            }

            let service = FoundationModelsTitleService()
            switch request.method {
            case .availability:
                response = .success(FoundationModelsResult(state: service.availability()))
            case .generateTitle:
                let prompt = try request.validatedPrompt()
                let title = try await service.generateTitle(prompt: prompt)
                response = .success(FoundationModelsResult(title: title))
            }
        } catch let error as FoundationModelsHelperError {
            response = .failure(error)
        } catch is DecodingError {
            response = .failure(
                FoundationModelsHelperError(
                    code: .invalidRequest,
                    message: "Invalid native helper request."
                )
            )
        } catch {
            response = .failure(
                FoundationModelsHelperError(
                    code: .internalFailure,
                    message: "The native helper could not complete the request."
                )
            )
        }

        do {
            let encoded = try JSONEncoder().encode(response)
            if let responseURL {
                try encoded.write(to: responseURL, options: .atomic)
            } else {
                FileHandle.standardOutput.write(encoded)
                FileHandle.standardOutput.write(Data([0x0A]))
            }
        } catch {
            FileHandle.standardError.write(Data("Native helper response encoding failed.\n".utf8))
        }
    }
}
