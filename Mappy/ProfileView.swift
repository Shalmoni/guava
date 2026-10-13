import SwiftUI

struct ProfileView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var game: GameStore
    @AppStorage("mappy.profile.name") private var profileName = "shalmoni"
    @State private var showingSettings = false

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                Color.white.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        xpCard
                        identityRow
                        statsGrid
                        personalStats
                        recentDrives
                    }
                    .padding(20)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.light, for: .navigationBar)
            .toolbarBackground(Color.white, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape.fill")
                    }
                    .accessibilityLabel("Technical settings")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .sheet(isPresented: $showingSettings) { SettingsView() }
    }

    private var xpCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label("GUAVA XP", systemImage: "sparkles")
                    .font(.guava(.caption, face: .bold))
                    .tracking(1.4)
                    .foregroundStyle(Color.mappyInk)
                Spacer()
                Text("LEVEL \(level)")
                    .font(.guava(.caption, face: .bold))
                    .foregroundStyle(Color.guavaSecondary)
            }

            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(game.totalXP)")
                    .font(.guava(size: 44, face: .heavy, relativeTo: .largeTitle))
                Text("XP")
                    .font(.guava(.title3, face: .bold))
                    .foregroundStyle(Color.guavaSecondary)
            }
            .foregroundStyle(Color.mappyInk)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.mappyInk.opacity(0.09))
                    Capsule()
                        .fill(Color.mappyAccent)
                        .frame(width: max(8, geometry.size.width * levelProgress))
                }
            }
            .frame(height: 8)

            Text("\(xpToNextLevel) XP to Level \(level + 1)")
                .font(.guava(.footnote, face: .demi))
                .foregroundStyle(Color.guavaSecondary)
        }
        .padding(15)
        .background(Color.mappyAccent.opacity(0.23), in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.mappyAccent.opacity(0.55)))
    }

    private var identityRow: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color.mappyAccent)
                Text(initial)
                    .font(.guava(size: 28, face: .heavy, relativeTo: .title))
                    .foregroundStyle(Color.mappyInk)
            }
            .frame(width: 68, height: 68)

            VStack(alignment: .leading, spacing: 4) {
                Text(profileName.isEmpty ? "Driver" : profileName)
                    .font(.guava(.title2, face: .bold))
                    .foregroundStyle(Color.mappyInk)
                Text("Level \(level) · \(game.trips.count) drives · Israel")
                    .font(.guava(.subheadline))
                    .foregroundStyle(Color.guavaSecondary)
            }
            Spacer()
        }
    }

    private var statsGrid: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ProfileStatCard(title: "Distance", value: distance(game.totalDistanceMeters), icon: "location.fill", tint: .mappyInk)
            ProfileStatCard(title: "Drive time", value: duration(game.totalDuration), icon: "clock.fill", tint: .mappyInk)
            ProfileStatCard(title: "Height traveled", value: height(game.totalHeightMeters), icon: "mountain.2.fill", tint: .mappyInk)
            ProfileStatCard(title: "Territory", value: territory(game.totalTerritoryMeters), icon: "point.topleft.down.to.point.bottomright.curvepath", tint: .mappyInk)
        }
    }

    private var personalStats: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Personal stats")
                .font(.guava(.title3, face: .bold))
                .foregroundStyle(Color.mappyInk)

            HStack(spacing: 12) {
                ProfileStatCard(title: "Average speed", value: speed(game.averageSpeedKilometresPerHour), icon: "speedometer", tint: .mappyInk)
                ProfileStatCard(title: "Highest altitude", value: altitude(game.highestAltitudeMeters), icon: "mountain.2.fill", tint: .mappyInk)
            }
        }
    }

    private var recentDrives: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recent drives")
                .font(.guava(.title3, face: .bold))
                .foregroundStyle(Color.mappyInk)

            if game.trips.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Your first drive starts your story", systemImage: "flag.checkered")
                        .font(.guava(.headline, face: .demi))
                        .foregroundStyle(Color.mappyInk)
                    Text("Distance, XP, height, and painted-road territory will appear here after a completed drive.")
                        .font(.guava(.footnote))
                        .foregroundStyle(Color.guavaSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color.guavaCard, in: RoundedRectangle(cornerRadius: 18))
            } else {
                ForEach(game.trips.prefix(8)) { trip in
                    HStack(spacing: 12) {
                        Image(systemName: "car.fill")
                            .frame(width: 42, height: 42)
                            .background(Color.mappyAccent.opacity(0.35), in: Circle())
                            .foregroundStyle(Color.mappyInk)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(trip.startedAt, style: .date)
                                .font(.guava(.subheadline, face: .demi))
                                .foregroundStyle(Color.mappyInk)
                            Text("\(distance(trip.distanceMeters)) · \(duration(trip.duration)) · \(height(trip.heightTraveledMeters)) height")
                                .font(.guava(.caption))
                                .foregroundStyle(Color.guavaSecondary)
                        }
                        Spacer()
                        Text("+\(trip.xpEarned) XP")
                            .font(.guava(.caption, face: .bold))
                            .foregroundStyle(Color.mappyInk)
                    }
                    .padding(11)
                    .background(Color.guavaCard, in: RoundedRectangle(cornerRadius: 18))
                }
            }
        }
    }

    private func territory(_ meters: Double) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private var level: Int { max(1, game.totalXP / 500 + 1) }
    private var levelProgress: Double { Double(game.totalXP % 500) / 500 }
    private var xpToNextLevel: Int { 500 - game.totalXP % 500 }
    private var initial: String { String((profileName.isEmpty ? "D" : profileName).prefix(1)).uppercased() }

    private func distance(_ meters: Double) -> String {
        String(format: "%.1f km", meters / 1000)
    }

    private func height(_ meters: Double) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private func duration(_ seconds: TimeInterval) -> String {
        let totalMinutes = max(0, Int(seconds / 60))
        return totalMinutes >= 60 ? "\(totalMinutes / 60)h \(totalMinutes % 60)m" : "\(totalMinutes)m"
    }

    private func speed(_ kilometresPerHour: Double) -> String {
        String(format: "%.1f km/h", kilometresPerHour)
    }

    private func altitude(_ meters: Double) -> String {
        "\(Int(meters.rounded())) m"
    }
}

private struct ProfileStatCard: View {
    let title: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.guava(.subheadline, face: .bold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.guava(.caption))
                    .foregroundStyle(Color.guavaSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            Text(value)
                .font(.guava(.title3, face: .bold))
                .foregroundStyle(Color.mappyInk)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .padding(13)
        .background(Color.guavaCard, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.mappyAccent.opacity(0.22)))
    }
}
