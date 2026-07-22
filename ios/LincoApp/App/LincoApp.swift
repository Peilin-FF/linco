import SwiftUI

@main
struct LincoApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .task { await model.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await model.handleSceneBecameActive() }
            case .background:
                Task { await model.handleSceneEnteredBackground() }
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
