// The desktop has already approved the path. Verify the bundle on disk and
// constrain the image macOS may actually execute if the path is replaced.
import Foundation
import LightweightCodeRequirements
import Security

func reject() -> Never {
    FileHandle.standardError.write(Data("Aiden could not verify the signed iMCP app and server. Reinstall iMCP and try again.\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
let checkOnly = args.count == 3 && args[1] == "--check"
guard args.count == 2 || checkOnly, let command = args.last,
      command.hasSuffix("/iMCP.app/Contents/MacOS/imcp-server") else { reject() }
let executable = URL(fileURLWithPath: command)
let bundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let applications = bundle.deletingLastPathComponent().resolvingSymlinksInPath()
guard executable.resolvingSymlinksInPath().path ==
        applications.appendingPathComponent("iMCP.app/Contents/MacOS/imcp-server").path
else { reject() }
let team = "TTY35UM57S"
func verify(_ url: URL, identifier: String) {
    let rule = "anchor apple generic and identifier \"\(identifier)\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\""
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
          let requirement,
          SecStaticCodeCheckValidity(code, [SecCSFlags(rawValue: kSecCSStrictValidate), .noNetworkAccess], requirement) == errSecSuccess
    else { reject() }
}

verify(bundle, identifier: "co.dododo.iMCP")
verify(executable, identifier: "imcp-server")
if checkOnly { exit(0) }

let child = Process()
child.executableURL = executable
do {
    child.launchRequirement = try LaunchCodeRequirement.allOf {
        SigningIdentifier("imcp-server")
        TeamIdentifier(team)
        ValidationCategory(.developerID)
        PlatformType(.macOS)
    }
    // Foundation starts the child in its own process group. Forward the
    // transport's teardown even when the server is stuck or ignores stdin.
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termination.setEventHandler {
        if child.isRunning { kill(-child.processIdentifier, SIGKILL) }
    }
    termination.resume()
    child.terminationHandler = { process in
        // A server that exits can leave descendants holding its pipes.
        kill(-process.processIdentifier, SIGKILL)
        exit(process.terminationReason == .exit ? process.terminationStatus : 128 + process.terminationStatus)
    }
    try child.run()
    withExtendedLifetime(termination) { dispatchMain() }
} catch {
    reject()
}
