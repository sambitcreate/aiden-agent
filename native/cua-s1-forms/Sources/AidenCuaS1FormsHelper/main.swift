import AidenCuaS1FormsCore
import Foundation

/// Thin stdin/stdout JSON-lines helper for CUA-S1-FORMS scoring. Electron main
/// spawns this executable directly (no `open`), writes one bounded JSON request
/// per line, and reads one JSON response per line. A `shutdown` request or EOF
/// exits the process.
@main
struct AidenCuaS1FormsHelper {
    static func main() async {
        let service = CuaS1FormsService()
        let input = FileHandle.standardInput
        let output = FileHandle.standardOutput
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        var buffer = Data()

        while true {
            // read(upToCount:) returns nil or empty on EOF.
            guard let chunk = try? input.read(upToCount: cuaS1FormsMaximumRequestBytes + 1),
                !chunk.isEmpty
            else {
                return
            }
            buffer.append(contentsOf: chunk)
            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let line = buffer[..<newlineIndex]
                buffer.removeSubrange(...newlineIndex)
                guard !line.isEmpty else { continue }
                let response: CuaS1FormsResponse
                if line.count > cuaS1FormsMaximumRequestBytes {
                    response = .failure(
                        id: "",
                        code: .invalidRequest,
                        message: "The form-fill request is too large."
                    )
                } else if let request = try? decoder.decode(CuaS1FormsRequest.self, from: line) {
                    response = await service.handle(request)
                } else {
                    response = .failure(
                        id: "",
                        code: .invalidRequest,
                        message: "Malformed form-fill request."
                    )
                }
                if let data = try? encoder.encode(response),
                    data.count <= cuaS1FormsMaximumResponseBytes
                {
                    output.write(data)
                    output.write(Data([0x0A]))
                } else {
                    let fallback = CuaS1FormsResponse.failure(
                        id: "",
                        code: .internalFailure,
                        message: "The form-fill helper could not encode its response."
                    )
                    if let data = try? encoder.encode(fallback) {
                        output.write(data)
                        output.write(Data([0x0A]))
                    }
                }
                if await service.shutdownRequested { return }
            }
            if buffer.count > cuaS1FormsMaximumRequestBytes {
                // A single oversized line without a newline — fail closed.
                let response = CuaS1FormsResponse.failure(
                    id: "",
                    code: .invalidRequest,
                    message: "The form-fill request is too large."
                )
                if let data = try? encoder.encode(response) {
                    output.write(data)
                    output.write(Data([0x0A]))
                }
                return
            }
        }
    }
}
