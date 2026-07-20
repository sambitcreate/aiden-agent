// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AidenAppleFoundationModels",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .library(
            name: "AidenFoundationModelsCore",
            targets: ["AidenFoundationModelsCore"]
        ),
        .executable(
            name: "AidenFoundationModelsHelper",
            targets: ["AidenFoundationModelsHelper"]
        )
    ],
    targets: [
        .target(
            name: "AidenFoundationModelsCore"
        ),
        .executableTarget(
            name: "AidenFoundationModelsHelper",
            dependencies: ["AidenFoundationModelsCore"]
        ),
        .testTarget(
            name: "AidenFoundationModelsCoreTests",
            dependencies: ["AidenFoundationModelsCore"]
        )
    ]
)
