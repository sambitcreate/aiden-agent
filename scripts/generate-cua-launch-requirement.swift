// Dev-time encoder for the cua-driver kernel launch constraint.
//
// Do not run this directly; run `node scripts/generate-cua-launch-requirement.mjs`
// (macOS 14.4+ with Xcode command-line tools). That wrapper passes the reviewed
// identifier, Team ID and per-slice CDHashes from scripts/computer-use-signing-pins.mjs,
// and either prints or checks the bytes embedded in
// native/computer-use-broker/src/darwin_security.m (`kCuaDriverLaunchRequirement`).
//
// Usage: swift scripts/generate-cua-launch-requirement.swift \
//          --identifier <id> --team <TEAMID> --cdhash <40 hex> [--cdhash <40 hex> ...]
// Prints the DER as one lowercase hex line on stdout.
//
// The DER comes from Apple's own LightweightCodeRequirements encoder (via
// NSTask.launchRequirementData), so the bytes match what the kernel parses.

import Foundation
import LightweightCodeRequirements

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("generate-cua-launch-requirement: \(message)\n".utf8))
    exit(2)
}

func parseHex(_ text: String) -> Data {
    guard text.count == 40, text.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
        fail("CDHash must be 40 lowercase hex characters: \(text)")
    }
    var bytes = [UInt8]()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        bytes.append(UInt8(text[index..<next], radix: 16)!)
        index = next
    }
    return Data(bytes)
}

var identifier: String?
var team: String?
var cdhashes: [Data] = []
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let flag = arguments.next() {
    guard let value = arguments.next() else { fail("missing value for \(flag)") }
    switch flag {
    case "--identifier": identifier = value
    case "--team": team = value
    case "--cdhash": cdhashes.append(parseHex(value))
    default: fail("unknown argument \(flag)")
    }
}
guard let identifier, !identifier.isEmpty else { fail("--identifier is required") }
guard let team, team.count == 10 else { fail("--team must be a 10-character Team ID") }
guard !cdhashes.isEmpty else { fail("at least one --cdhash is required") }

guard #available(macOS 14.4, *) else { fail("macOS 14.4 or later is required") }

let requirement: LaunchCodeRequirement
do {
    requirement = try LaunchCodeRequirement.allOf {
        CodeDirectoryHash.in(cdhashes)
        ProcessCodeSigningFlags.isSuperset(of: [
            .isSigned,
            .isHardenedRuntimeEnforced,
            .terminatesOnCodeSigningFailure,
            .isDynamicallyValid,
        ])
        PlatformType(.macOS)
        SigningIdentifier(identifier)
        TeamIdentifier(team)
        ValidationCategory(.developerID)
    }
} catch {
    fail("LightweightCodeRequirements rejected the constraint: \(error)")
}

let process = Process()
process.launchRequirement = requirement
guard let der = (process as NSObject).value(forKey: "launchRequirementData") as? Data else {
    fail("NSTask did not expose launchRequirementData")
}
print(der.map { String(format: "%02x", $0) }.joined())
