// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TaskManagerNative",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    targets: [
        .executableTarget(
            name: "TaskManagerNative",
            path: "Sources/TaskManagerNative",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
    ]
)
