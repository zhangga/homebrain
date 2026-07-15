import Darwin
import Foundation

let invokedPath = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let macOSDirectory = invokedPath.deletingLastPathComponent()
let contentsDirectory = macOSDirectory.deletingLastPathComponent()
let appRoot = contentsDirectory.deletingLastPathComponent()
let resources = contentsDirectory.appendingPathComponent("Resources", isDirectory: true)
let bunPath = resources.appendingPathComponent("bin/bun").path
let entryPath = resources.appendingPathComponent("app/homeagent.js").path

setenv("HOMEAGENT_BUNDLED_APP_ROOT", appRoot.path, 1)
setenv("HOMEAGENT_LAUNCHER_PATH", invokedPath.path, 1)

let arguments = [bunPath, entryPath] + Array(CommandLine.arguments.dropFirst())
var cArguments = arguments.map { strdup(String($0)) }
cArguments.append(nil)
defer {
  for pointer in cArguments where pointer != nil { free(pointer) }
}

_ = cArguments.withUnsafeMutableBufferPointer { buffer in
  execv(bunPath, buffer.baseAddress)
}

let message = String(cString: strerror(errno))
fputs("HomeAgent could not start: \(message)\n", stderr)
exit(126)
