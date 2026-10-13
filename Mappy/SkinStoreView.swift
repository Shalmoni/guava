import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var game: GameStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("mappy.profile.name") private var profileName = "shalmoni"

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    TextField("Display name", text: $profileName)
                    LabeledContent("Guava XP", value: "\(game.totalXP)")
                    LabeledContent("Account", value: "Local prototype")
                }

                Section("Location and privacy") {
                    LabeledContent("Location access", value: "While Using App")
                    LabeledContent("Drive recording", value: "After you tap Start")
                    LabeledContent("Shared with other drivers", value: "Nothing")
                    LabeledContent("Drive history", value: "\(game.trips.count) on this iPhone")
                    Text("Guava uses your location to navigate, measure altitude, and record the path of a drive you start. In this prototype, your exact route and profile stay on this iPhone and are not sent to other drivers.")
                        .font(.guava(.footnote))
                        .foregroundStyle(.secondary)
                    Text("Future community play should share only the minimum needed—such as your public name, totals, rank, and claimed road-segment IDs—not a public live or point-by-point route by default.")
                        .font(.guava(.footnote))
                        .foregroundStyle(.secondary)
                }

                Section("App") {
                    LabeledContent("Version", value: "0.1.0")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct SkinStoreView: View {
    @EnvironmentObject private var model: MappyModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Change your world")
                            .font(.guava(size: 30, face: .bold, relativeTo: .title))
                        Text("Switch anytime. Every available skin is free in this test build.")
                            .foregroundStyle(.secondary)
                    }

                    ForEach(MappySkin.allCases) { skin in
                        Button {
                            model.selectedSkin = skin
                            dismiss()
                        } label: {
                            HStack(spacing: 16) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 17)
                                        .fill(background(for: skin))
                                    Image(systemName: skin.icon)
                                        .font(.system(size: 25, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                                .frame(width: 66, height: 66)
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack {
                                        Text(skin.rawValue).font(.guava(.headline, face: .demi)).foregroundStyle(.primary)
                                    }
                                    Text(description(for: skin))
                                        .font(.guava(.subheadline)).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                                }
                                Spacer()
                                if model.selectedSkin == skin {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.mappyInk).font(.title2)
                                }
                            }
                            .padding(14)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
                        }
                    }

                    Text("Altitude uses worldwide open elevation terrain tiles. Biome and Old World are the next skin prototypes. All current test distribution is free.")
                        .font(.guava(.footnote)).foregroundStyle(.secondary).padding(.horizontal, 4)
                }
                .padding(20)
            }
            .navigationTitle("Map skins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func background(for skin: MappySkin) -> LinearGradient {
        switch skin {
        case .regular: LinearGradient(colors: [.mappyAccent, .white], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .satellite: LinearGradient(colors: [.indigo, .green], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .territory: LinearGradient(colors: [.mappyAccent, .white], startPoint: .bottomLeading, endPoint: .topTrailing)
        case .roadPulse: LinearGradient(colors: [.mappyAccent.opacity(0.35), .mappyInk], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .altitude: LinearGradient(colors: [.green, .yellow, .brown], startPoint: .bottomLeading, endPoint: .topTrailing)
        }
    }

    private func description(for skin: MappySkin) -> String {
        switch skin {
        case .regular: "Clear streets, places and live navigation."
        case .satellite: "Real-world imagery from above."
        case .territory: "Preview your painted roads. Shared claims are coming."
        case .roadPulse: "See which roads get used most. Filter everybody or just you."
        case .altitude: "Terrain relief with your current altitude."
        }
    }
}
