// FaceBox.swift — locate faces in a still using Apple's Vision framework.
//
// Why this exists (2026-08-19): sponsored thumbnails place two people side by side, and the two
// source photos are never framed alike — one is a studio headshot, the other a webcam grab. Scaling
// either by its bounding box puts the heads at wildly different sizes. Scaling by the FACE puts
// them at the same size, which is what the principal's hand-made references do.
//
// Emits JSON on stdout, one object per face, largest first. All values are fractions of the image,
// origin TOP-LEFT (Vision's own origin is bottom-left; converted here so callers never have to).
//
//   { "w": <px>, "h": <px>, "faces": [ { "x", "y", "w", "h", "cx", "cy", "eyeY" } ] }
//
// Build: swiftc -O FaceBox.swift -o facebox

import Foundation
import Vision
import AppKit

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("FaceBox: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: facebox <image>") }
let path = args[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("cannot read image: \(path)")
}

let W = Double(cg.width)
let H = Double(cg.height)

let request = VNDetectFaceLandmarksRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { fail("vision failed: \(error)") }

var out: [[String: Double]] = []
for obs in (request.results ?? []) {
    let b = obs.boundingBox  // normalized, origin bottom-left
    let x = Double(b.origin.x)
    let w = Double(b.size.width)
    let h = Double(b.size.height)
    let y = 1.0 - Double(b.origin.y) - h  // flip to top-left origin

    // Eye line, when landmarks resolved — the steadiest vertical anchor on a face.
    var eyeY = y + h * 0.42
    if let lm = obs.landmarks {
        var pts: [CGPoint] = []
        if let l = lm.leftEye { pts += l.normalizedPoints }
        if let r = lm.rightEye { pts += r.normalizedPoints }
        if !pts.isEmpty {
            // landmark points are normalized WITHIN the face bounding box, origin bottom-left
            let meanY = pts.reduce(0.0) { $0 + Double($1.y) } / Double(pts.count)
            eyeY = y + h * (1.0 - meanY)
        }
    }
    out.append([
        "x": x, "y": y, "w": w, "h": h,
        "cx": x + w / 2, "cy": y + h / 2, "eyeY": eyeY,
    ])
}
out.sort { ($0["w"] ?? 0) * ($0["h"] ?? 0) > ($1["w"] ?? 0) * ($1["h"] ?? 0) }

let payload: [String: Any] = ["w": W, "h": H, "faces": out]
let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
