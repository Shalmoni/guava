import SwiftUI

@main
struct MappyApp: App {
    @StateObject private var model = MappyModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .environmentObject(model.game)
                .preferredColorScheme(.light)
                .font(.guava(.body))
        }
    }
}
