// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LincoCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "LincoCore", targets: ["LincoCore"])
    ],
    targets: [
        .target(name: "LincoCore"),
        .testTarget(name: "LincoCoreTests", dependencies: ["LincoCore"])
    ]
)
