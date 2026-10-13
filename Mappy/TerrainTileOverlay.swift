import MapKit
import UIKit

final class TerrainTileOverlay: MKTileOverlay {
    private static let sourceMaximumZ = 15

    init() {
        super.init(urlTemplate: nil)
        tileSize = CGSize(width: 256, height: 256)
        minimumZ = 3
        // The source stops at z15. Higher map zooms overzoom the correct
        // subsection of the z15 parent tile so Altitude never disappears.
        maximumZ = 20
        canReplaceMapContent = false
    }

    override func url(forTilePath path: MKTileOverlayPath) -> URL {
        let source = Self.sourcePath(for: path)
        return URL(string: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/\(source.z)/\(source.x)/\(source.y).png")!
    }

    override func loadTile(at path: MKTileOverlayPath, result: @escaping (Data?, (any Error)?) -> Void) {
        let request = URLRequest(url: url(forTilePath: path), cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 20)
        URLSession.shared.dataTask(with: request) { data, _, error in
            guard let data, error == nil else {
                result(nil, error)
                return
            }
            do {
                let rendered = try Self.renderTerrain(from: data)
                result(try Self.overzoom(rendered, for: path), nil)
            } catch {
                result(nil, error)
            }
        }.resume()
    }

    private static func sourcePath(for path: MKTileOverlayPath) -> MKTileOverlayPath {
        guard path.z > sourceMaximumZ else { return path }
        let divisor = 1 << (path.z - sourceMaximumZ)
        return MKTileOverlayPath(
            x: path.x / divisor,
            y: path.y / divisor,
            z: sourceMaximumZ,
            contentScaleFactor: path.contentScaleFactor
        )
    }

    private static func overzoom(_ renderedData: Data, for path: MKTileOverlayPath) throws -> Data {
        guard path.z > sourceMaximumZ else { return renderedData }
        guard let image = UIImage(data: renderedData)?.cgImage else { throw TerrainError.invalidImage }

        let divisor = 1 << (path.z - sourceMaximumZ)
        let sourceX = path.x % divisor
        let sourceY = path.y % divisor
        let cropWidth = CGFloat(image.width) / CGFloat(divisor)
        let cropHeight = CGFloat(image.height) / CGFloat(divisor)
        let cropRect = CGRect(
            x: CGFloat(sourceX) * cropWidth,
            y: CGFloat(sourceY) * cropHeight,
            width: cropWidth,
            height: cropHeight
        ).integral

        guard let cropped = image.cropping(to: cropRect) else { throw TerrainError.invalidImage }
        let outputSize = CGSize(width: 256, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let output = UIGraphicsImageRenderer(size: outputSize, format: format).image { renderer in
            renderer.cgContext.interpolationQuality = .high
            UIImage(cgImage: cropped).draw(in: CGRect(origin: .zero, size: outputSize))
        }
        guard let png = output.pngData() else { throw TerrainError.invalidImage }
        return png
    }

    private static func renderTerrain(from data: Data) throws -> Data {
        guard let image = UIImage(data: data)?.cgImage else { throw TerrainError.invalidImage }
        let width = image.width
        let height = image.height
        let rowBytes = width * 4
        var pixels = [UInt8](repeating: 0, count: height * rowBytes)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: rowBytes,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw TerrainError.invalidImage }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        var heights = [Double](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                let offset = y * rowBytes + x * 4
                heights[y * width + x] = Double(pixels[offset]) * 256
                    + Double(pixels[offset + 1])
                    + Double(pixels[offset + 2]) / 256
                    - 32_768
            }
        }

        for y in 0..<height {
            for x in 0..<width {
                let index = y * width + x
                let left = heights[y * width + max(0, x - 1)]
                let right = heights[y * width + min(width - 1, x + 1)]
                let up = heights[max(0, y - 1) * width + x]
                let down = heights[min(height - 1, y + 1) * width + x]
                var relief = min(1.30, max(0.48, 0.94 + (left - right + down - up) * 0.012))
                let contour = Int(floor(heights[index] / 25))
                let rightContour = Int(floor(right / 25))
                let downContour = Int(floor(down / 25))
                if contour != rightContour || contour != downContour {
                    relief *= contour.isMultiple(of: 4) ? 0.52 : 0.70
                }
                let color = ramp(for: heights[index])
                let offset = y * rowBytes + x * 4
                pixels[offset] = UInt8(min(255, max(0, color.r * relief)))
                pixels[offset + 1] = UInt8(min(255, max(0, color.g * relief)))
                pixels[offset + 2] = UInt8(min(255, max(0, color.b * relief)))
                pixels[offset + 3] = heights[index] <= 0 ? 115 : 205
            }
        }

        guard let outputContext = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: rowBytes,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ), let output = outputContext.makeImage() else { throw TerrainError.invalidImage }

        guard let png = UIImage(cgImage: output).pngData() else { throw TerrainError.invalidImage }
        return png
    }

    private static func ramp(for elevation: Double) -> (r: Double, g: Double, b: Double) {
        let stops: [(Double, Double, Double, Double)] = [
            (-100, 65, 130, 177), (0, 35, 121, 76),
            (25, 44, 143, 72), (50, 66, 161, 72),
            (75, 96, 177, 73), (100, 130, 188, 78),
            (150, 166, 190, 83), (250, 201, 187, 92),
            (400, 220, 167, 78), (550, 205, 145, 65),
            (650, 187, 119, 58), (725, 166, 98, 57),
            (800, 142, 78, 58), (1_200, 101, 67, 62),
            (2_000, 215, 208, 194)
        ]
        if elevation <= stops[0].0 { return (stops[0].1, stops[0].2, stops[0].3) }
        for index in 1..<stops.count where elevation <= stops[index].0 {
            let low = stops[index - 1]
            let high = stops[index]
            let amount = (elevation - low.0) / (high.0 - low.0)
            return (
                low.1 + (high.1 - low.1) * amount,
                low.2 + (high.2 - low.2) * amount,
                low.3 + (high.3 - low.3) * amount
            )
        }
        let last = stops[stops.count - 1]
        return (last.1, last.2, last.3)
    }

    private enum TerrainError: Error { case invalidImage }
}
