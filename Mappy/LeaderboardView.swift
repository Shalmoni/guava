import MapKit
import SwiftUI

struct LeaderboardView: View {
    @EnvironmentObject private var game: GameStore
    @Environment(\.dismiss) private var dismiss
    @State private var metric: LeaderboardMetric = .xp
    @State private var showingTerritoryMap = false

    private var players: [LeaderboardPlayer] { game.leaderboard(metric: metric) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    VStack(spacing: 5) {
                        Text("Everyone")
                            .font(.guava(size: 34, face: .bold, relativeTo: .largeTitle))
                        Text("One community while Guava is young")
                            .font(.guava(.subheadline))
                            .foregroundStyle(.secondary)
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(LeaderboardMetric.allCases) { option in
                                Button(option.rawValue) { metric = option }
                                    .font(.guava(.subheadline, face: .demi))
                                    .padding(.horizontal, 14)
                                    .frame(height: 40)
                                    .foregroundStyle(Color.mappyInk)
                                    .background(metric == option ? Color.mappyAccent : Color(.secondarySystemBackground), in: Capsule())
                            }
                        }
                        .padding(.horizontal, 1)
                    }

                    podium

                    if metric == .territory, let king = players.first {
                        VStack(spacing: 10) {
                            Label("\(king.name) is King of the Map", systemImage: "crown.fill")
                                .font(.guava(.headline, face: .demi))
                                .padding(.horizontal, 16)
                                .frame(height: 48)
                                .frame(maxWidth: .infinity)
                                .background(.yellow.opacity(0.22), in: RoundedRectangle(cornerRadius: 16))

                            Button { showingTerritoryMap = true } label: {
                                Label("View territory map", systemImage: "map.fill")
                                    .font(.guava(.headline, face: .demi))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    VStack(spacing: 0) {
                        ForEach(Array(players.enumerated()), id: \.element.id) { index, player in
                            HStack(spacing: 12) {
                                Text("\(index + 1)")
                                    .font(.guava(.headline, face: .demi).monospacedDigit())
                                    .foregroundStyle(index < 3 ? .primary : .secondary)
                                    .frame(width: 28)
                                avatar(player, size: 40)
                                Text(player.name)
                                    .font(.guava(.headline, face: .demi))
                                if player.isCurrentUser {
                                    Text("YOU")
                                        .font(.guava(size: 9, face: .heavy, relativeTo: .caption2))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 3)
                                        .background(Color.mappyAccent.opacity(0.28), in: Capsule())
                                        .foregroundStyle(Color.mappyInk)
                                }
                                Spacer()
                                Text(formatted(player.value(for: metric)))
                                    .font(.guava(.headline, face: .demi).monospacedDigit())
                            }
                            .padding(.horizontal, 14)
                            .frame(height: 62)
                            if index < players.count - 1 { Divider().padding(.leading, 62) }
                        }
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))

                    Text("Preview community players are sample data until the shared backend is connected. Your row uses your real recorded drives on this device.")
                        .font(.guava(.footnote))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(20)
            }
            .navigationTitle("Leaderboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .sheet(isPresented: $showingTerritoryMap) {
            TerritoryLeaderboardMap(trips: game.trips, territoryMeters: game.totalTerritoryMeters)
        }
    }

    private var podium: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if players.count > 1 { podiumPlace(players[1], place: 2, height: 112, color: .gray) }
            if let first = players.first { podiumPlace(first, place: 1, height: 145, color: .yellow) }
            if players.count > 2 { podiumPlace(players[2], place: 3, height: 92, color: .brown) }
        }
        .frame(maxWidth: .infinity)
    }

    private func podiumPlace(_ player: LeaderboardPlayer, place: Int, height: CGFloat, color: Color) -> some View {
        VStack(spacing: 7) {
            ZStack(alignment: .topTrailing) {
                avatar(player, size: place == 1 ? 62 : 50)
                Text("\(place)")
                    .font(.guava(.caption2, face: .bold))
                    .frame(width: 22, height: 22)
                    .background(color, in: Circle())
                    .foregroundStyle(place == 1 ? .black : .white)
                    .offset(x: 5, y: -5)
            }
            Text(player.name).font(.guava(.caption, face: .demi)).lineLimit(1)
            Text(formatted(player.value(for: metric))).font(.guava(.caption2).monospacedDigit()).foregroundStyle(.secondary)
            RoundedRectangle(cornerRadius: 14)
                .fill(color.opacity(place == 1 ? 0.58 : 0.28))
                .frame(height: height)
                .overlay(alignment: .top) {
                    Text("\(place)").font(.guava(.title, face: .bold)).padding(.top, 12).foregroundStyle(place == 1 ? .black.opacity(0.7) : .primary.opacity(0.55))
                }
        }
        .frame(maxWidth: .infinity)
    }

    private func avatar(_ player: LeaderboardPlayer, size: CGFloat) -> some View {
        Text(player.initials)
            .font(.guava(size: size * 0.38, face: .bold, relativeTo: .title3))
            .frame(width: size, height: size)
            .background(player.isCurrentUser ? Color.mappyAccent : Color.mappyInk.opacity(0.82), in: Circle())
            .foregroundStyle(player.isCurrentUser ? Color.mappyInk : .white)
    }

    private func formatted(_ value: Double) -> String {
        switch metric {
        case .xp: "\(Int(value)) XP"
        case .height: value >= 1000 ? String(format: "%.1f km", value / 1000) : "\(Int(value)) m"
        case .territory: value >= 1000 ? String(format: "%.1f km", value / 1000) : "\(Int(value)) m"
        case .distance: value >= 1000 ? String(format: "%.1f km", value / 1000) : "\(Int(value)) m"
        }
    }
}

private struct TerritoryLeaderboardMap: View {
    @Environment(\.dismiss) private var dismiss
    let trips: [RecordedTrip]
    let territoryMeters: Double
    @State private var position: MapCameraPosition

    init(trips: [RecordedTrip], territoryMeters: Double) {
        self.trips = trips
        self.territoryMeters = territoryMeters
        let polylines = trips.compactMap { trip -> MKPolyline? in
            let coordinates = trip.territoryPaintPoints.map {
                CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
            }
            guard coordinates.count > 1 else { return nil }
            return MKPolyline(coordinates: coordinates, count: coordinates.count)
        }
        if polylines.isEmpty {
            _position = State(initialValue: .region(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 31.7683, longitude: 35.2137),
                span: MKCoordinateSpan(latitudeDelta: 0.12, longitudeDelta: 0.12)
            )))
        } else {
            let bounds = polylines.reduce(MKMapRect.null) { $0.union($1.boundingMapRect) }
            let horizontalPadding = max(bounds.width * 0.35, 1_200)
            let verticalPadding = max(bounds.height * 0.35, 1_200)
            _position = State(initialValue: .rect(bounds.insetBy(dx: -horizontalPadding, dy: -verticalPadding)))
        }
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Map(position: $position) {
                    ForEach(trips) { trip in
                        let coordinates = trip.territoryPaintPoints.map {
                            CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
                        }
                        if coordinates.count > 1 {
                            MapPolyline(coordinates: coordinates)
                                .stroke(.black.opacity(0.20), style: StrokeStyle(lineWidth: 11, lineCap: .round, lineJoin: .round))
                        }
                    }
                    ForEach(trips) { trip in
                        let coordinates = trip.territoryPaintPoints.map {
                            CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
                        }
                        if coordinates.count > 1 {
                            MapPolyline(coordinates: coordinates)
                                .stroke(Color.mappyAccent.opacity(0.9), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
                        }
                    }
                }
                .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))

                VStack(spacing: 8) {
                    if trips.isEmpty {
                        Label("Finish a 50 m drive to paint your first road", systemImage: "flag.checkered")
                            .font(.guava(.headline, face: .demi))
                    } else {
                        Label("Your territory · \(territoryText)", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                            .font(.guava(.headline, face: .demi))
                    }
                    Text("Only your real local roads are shown. Rival territory appears after community sync exists.")
                        .font(.guava(.footnote))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(14)
                .frame(maxWidth: .infinity)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                .padding(16)
            }
            .navigationTitle("Territory map")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var territoryText: String {
        territoryMeters >= 1000
            ? String(format: "%.1f km", territoryMeters / 1000)
            : "\(Int(territoryMeters.rounded())) m"
    }
}
