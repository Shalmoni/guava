import SwiftUI

struct TripRecapView: View {
    @EnvironmentObject private var model: MappyModel
    @EnvironmentObject private var game: GameStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()

            if let trip = game.lastTrip {
                ScrollView {
                    VStack(spacing: 24) {
                        Text("DRIVE COMPLETE")
                            .font(.guava(.caption, face: .bold)).tracking(2)
                            .foregroundStyle(Color.guavaSecondary)

                        Text("Your map grew.")
                            .font(.guava(size: 38, face: .bold, relativeTo: .largeTitle))
                            .foregroundStyle(Color.mappyInk)

                        VStack(spacing: 4) {
                            Text("+\(trip.xpEarned)")
                                .font(.guava(size: 64, face: .bold, relativeTo: .largeTitle))
                            Text("GUAVA XP").font(.guava(.caption, face: .bold)).tracking(1.5).opacity(0.7)
                        }
                        .foregroundStyle(Color.mappyInk)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 22)
                        .background(Color.mappyAccent.opacity(0.23), in: RoundedRectangle(cornerRadius: 28))

                        HStack(spacing: 12) {
                            RecapStat(value: distance(trip.distanceMeters), label: "DISTANCE")
                            RecapStat(value: height(trip.heightTraveledMeters), label: "HEIGHT")
                            RecapStat(value: duration(trip.duration), label: "TIME")
                        }

                        VStack(spacing: 12) {
                            resultRow("New territory", value: territory(Double(trip.newCellCount) * TerritoryCell.sizeMeters), icon: "point.topleft.down.to.point.bottomright.curvepath")
                            resultRow("Painted road", value: territory(Double(trip.cells.count) * TerritoryCell.sizeMeters), icon: "map.fill")
                            resultRow("Climbed", value: height(trip.ascentMeters), icon: "arrow.up.right")
                            resultRow("Descended", value: height(trip.descentMeters), icon: "arrow.down.right")
                        }
                        .padding(18)
                        .background(Color.guavaCard, in: RoundedRectangle(cornerRadius: 22))

                        Text("Height traveled is total meaningful altitude change: climbing plus descending. GPS changes smaller than 3 m are ignored.")
                            .font(.guava(.footnote))
                            .foregroundStyle(Color.guavaSecondary)
                            .multilineTextAlignment(.center)

                        Button {
                            model.clearRoute()
                            dismiss()
                        } label: {
                            Text("Back to the map")
                                .font(.guava(.headline, face: .demi))
                                .frame(maxWidth: .infinity)
                                .frame(height: 54)
                                .background(Color.mappyAccent, in: RoundedRectangle(cornerRadius: 17))
                                .foregroundStyle(Color.mappyInk)
                        }
                    }
                    .padding(24)
                }
            }
        }
    }

    private func resultRow(_ title: String, value: String, icon: String) -> some View {
        HStack {
            Image(systemName: icon).frame(width: 26).foregroundStyle(Color.mappyInk)
            Text(title).foregroundStyle(Color.guavaSecondary)
            Spacer()
            Text(value).fontWeight(.semibold).foregroundStyle(Color.mappyInk)
        }
    }

    private func distance(_ meters: Double) -> String {
        String(format: "%.1f km", meters / 1000)
    }

    private func height(_ meters: Double) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private func territory(_ meters: Double) -> String {
        meters >= 1000 ? String(format: "%.1f km", meters / 1000) : "\(Int(meters.rounded())) m"
    }

    private func duration(_ seconds: TimeInterval) -> String {
        let minutes = Int(seconds / 60)
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(max(1, minutes)) min"
    }
}

private struct RecapStat: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 5) {
            Text(value).font(.guava(.headline, face: .demi).monospacedDigit())
            Text(label).font(.guava(size: 9, face: .bold, relativeTo: .caption2)).foregroundStyle(Color.guavaSecondary)
        }
        .foregroundStyle(Color.mappyInk)
        .frame(maxWidth: .infinity)
    }
}
