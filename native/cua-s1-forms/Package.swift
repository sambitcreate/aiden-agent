// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AidenCuaS1Forms",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "AidenCuaS1FormsCore",
            targets: ["AidenCuaS1FormsCore"]
        ),
        .executable(
            name: "AidenCuaS1FormsHelper",
            targets: ["AidenCuaS1FormsHelper"]
        )
    ],
    targets: [
        .target(
            name: "AidenCuaS1FormsCore"
        ),
        .executableTarget(
            name: "AidenCuaS1FormsHelper",
            dependencies: ["AidenCuaS1FormsCore"]
        ),
        .testTarget(
            name: "AidenCuaS1FormsCoreTests",
            dependencies: ["AidenCuaS1FormsCore"],
            resources: [.copy("Fixtures")]
        )
    ]
)
