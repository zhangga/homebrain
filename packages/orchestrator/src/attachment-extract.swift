import AppKit
import Foundation
import PDFKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fputs("usage: attachment-extract.swift <image|pdf> <path>\n", stderr)
    exit(2)
}

let mode = arguments[1]
let path = arguments[2]
guard mode == "image" || mode == "pdf", !path.isEmpty else {
    fputs("unsupported extraction mode\n", stderr)
    exit(2)
}

var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
      !isDirectory.boolValue else {
    fputs("input must be an existing file\n", stderr)
    exit(3)
}
let url = URL(fileURLWithPath: path)

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

func cgImage(_ image: NSImage) -> CGImage? {
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

do {
    if mode == "image" {
        guard let image = NSImage(contentsOf: url), let imageData = cgImage(image) else {
            exit(3)
        }
        print(try recognize(imageData))
    } else {
        guard let document = PDFDocument(url: url) else {
            exit(3)
        }
        var parts: [String] = []
        for index in 0..<min(document.pageCount, 50) {
            guard let page = document.page(at: index) else { continue }
            if let text = page.string,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parts.append(text)
            }
        }
        print(parts.joined(separator: "\n\n"))
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(4)
}
