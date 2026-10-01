// Runs a built plugin.js the way Alas runs API 4 plugins, and times every call.
//
//   scripts/jsc-run <plugin.js> [messages.jsonl] [-v] [--png frame.png]
//
// The plugin gets a fresh JSContextGroup whose global object holds only the ECMAScript
// built-ins and `alas` (`send`, `present`). The script is evaluated once, `alas/activate` (API 4)
// is delivered, then each line of messages.jsonl, one `handle(json)` call per line. Calls are
// limited to 250 ms (1 s for evaluation and activation) with the same private watchdog Alas uses,
// which counts the thread's CPU time.
//
// A reply line may name its id as "$<method>", e.g. {"jsonrpc":"2.0","id":"$storage/get",...}:
// it becomes the id of the latest request the plugin sent with that method.
//
// Exits 1 when the plugin would be stopped: an exception, a call over its limit, or a send or
// frame Alas would refuse.

import Foundation
import ImageIO
import JavaScriptCore
import UniformTypeIdentifiers

typealias ShouldTerminate = @convention(c) (JSContextRef?, UnsafeMutableRawPointer?) -> Bool
@_silgen_name("JSContextGroupSetExecutionTimeLimit")
func JSContextGroupSetExecutionTimeLimit(_ group: JSContextGroupRef, _ limit: Double, _ callback: ShouldTerminate?, _ context: UnsafeMutableRawPointer?)

let maxMessageBytes = 1 << 20
let maxSendsPerCall = 64
let maxFrameBytes = 4 << 20
let callLimit = 0.25
let activationLimit = 1.0

setvbuf(stdout, nil, _IOLBF, 0)
var arguments = Array(CommandLine.arguments.dropFirst())
let verbose = arguments.contains("-v")
arguments.removeAll { $0 == "-v" }
var pngPath: String?
if let i = arguments.firstIndex(of: "--png"), i + 1 < arguments.count {
    pngPath = arguments[i + 1]
    arguments.removeSubrange(i...(i + 1))
}
guard let scriptPath = arguments.first else {
    FileHandle.standardError.write("usage: jsc-run <plugin.js> [messages.jsonl] [-v] [--png frame.png]\n".data(using: .utf8)!)
    exit(2)
}
let script = try String(contentsOfFile: scriptPath, encoding: .utf8)
let lines = try arguments.dropFirst().first.map { try String(contentsOfFile: $0, encoding: .utf8) }?
    .split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? []

let group = JSContextGroupCreate()!
let context = JSContext(jsGlobalContextRef: JSGlobalContextCreateInGroup(group, nil))!
let global = context.globalObject!
// JavaScriptCore adds these to every global object; neither is part of the plugin ABI.
for name in ["console", "WebAssembly"] { global.deleteProperty(name) }

var sent: [String] = []
var violation: String?
var frames = 0
var lastFrame: (width: Int, height: Int, pixels: Data)?

func refuse(_ reason: String) {
    violation = violation ?? reason
    JSContext.current().exception = JSValue(newErrorFromMessage: reason, in: JSContext.current())
}

let send: @convention(block) (JSValue) -> Void = { value in
    guard value.isString, let json = value.toString() else { return refuse("alas.send takes a string") }
    if json.utf8.count > maxMessageBytes { return refuse("a message over 1 MiB (\(json.utf8.count) bytes)") }
    if sent.count >= maxSendsPerCall { return refuse("more than \(maxSendsPerCall) messages in one call") }
    sent.append(json)
}
let present: @convention(block) (JSValue, JSValue, JSValue) -> Void = { tab, pixels, width in
    let ctx = JSContext.current().jsGlobalContextRef
    guard JSValueGetTypedArrayType(ctx, pixels.jsValueRef, nil) == kJSTypedArrayTypeUint8Array,
          let object = JSValueToObject(ctx, pixels.jsValueRef, nil) else { return refuse("alas.present takes a Uint8Array") }
    let length = JSObjectGetTypedArrayByteLength(ctx, object, nil)
    let w = Int(width.toInt32())
    guard tab.isNumber, width.isNumber, (1...1024).contains(w), length > 0, length % (w * 4) == 0,
          (1...1024).contains(length / (w * 4)), length <= maxFrameBytes else {
        return refuse("invalid frame: \(length) bytes at width \(w)")
    }
    // Alas copies the frame during the call, so the copy is part of the measured time.
    let bytes = JSObjectGetTypedArrayBytesPtr(ctx, object, nil)!
    lastFrame = (w, length / (w * 4), Data(bytes: bytes, count: length))
    frames += 1
}
let alas = JSValue(newObjectIn: context)!
alas.setObject(send, forKeyedSubscript: "send" as NSString)
alas.setObject(present, forKeyedSubscript: "present" as NSString)
global.setObject(alas, forKeyedSubscript: "alas" as NSString)

let clock = ContinuousClock()
func milliseconds(_ d: Duration) -> Double {
    Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
}

/// This thread's CPU time: on a loaded machine wall time also counts time spent preempted.
func cpuMilliseconds() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e6
}

/// Runs `body` under `limit` seconds; returns the wall and CPU times and the reason the plugin stopped, if it did.
func timed(_ limit: Double, _ body: () -> Void) -> (Double, Double, String?) {
    JSContextGroupSetExecutionTimeLimit(group, limit, { _, _ in true }, nil)
    context.exception = nil
    violation = nil
    let start = clock.now, cpuStart = cpuMilliseconds()
    body()
    let ms = milliseconds(clock.now - start), cpu = cpuMilliseconds() - cpuStart
    if let violation { return (ms, cpu, violation) }
    // The watchdog counts the thread's CPU time, so on a loaded machine a call can run past the
    // limit in wall time and still finish.
    if let exception = context.exception {
        return (ms, cpu, cpu >= limit * 1000 ? "took longer than \(Int(limit * 1000)) ms (\(exception))" : "threw: \(exception)")
    }
    return (ms, cpu, nil)
}

var lastRequest: [String: Int] = [:]
var results: [(label: String, ms: Double, cpu: Double)] = []
var failed = false

func label(_ json: String) -> String {
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return "?" }
    guard let method = object["method"] as? String else { return "reply" }
    let params = object["params"] as? [String: Any]
    if method == "view/event", let id = params?["id"] as? String { return "view/event \(id)" }
    if method == "canvas/click", let region = params?["region"] as? String { return "canvas/click \(region)" }
    return method
}

/// Replaces an id of "$<method>" with the latest request id sent with that method.
func resolve(_ line: String) -> String {
    guard var object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let placeholder = object["id"] as? String, placeholder.hasPrefix("$") else { return line }
    guard let id = lastRequest[String(placeholder.dropFirst())] else {
        print("no \(placeholder.dropFirst()) request was sent before: \(line.prefix(80))")
        exit(1)
    }
    object["id"] = id
    return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
}

func pad(_ text: String) -> String { text.count >= 34 ? String(text.prefix(34)) : text.padding(toLength: 34, withPad: " ", startingAt: 0) }

func report(_ index: Int, _ label: String, _ ms: Double, _ cpu: Double, _ stopped: String?) {
    let bytes = sent.reduce(0) { $0 + $1.utf8.count }
    print(String(format: "%4d  ", index) + pad(label) + String(format: " %8.3f ms  cpu %8.3f ms  sends %2d  %7d B  frames %d", ms, cpu, sent.count, bytes, frames))
    for json in sent {
        if let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
           let id = object["id"] as? Int, let method = object["method"] as? String {
            lastRequest[method] = id
        }
        if verbose { print("      → \(json.prefix(160))") }
    }
    if let stopped {
        print("      stopped: \(stopped)")
        failed = true
    }
    // Summaries group ids that differ only in numbers, e.g. every `view/event comment-<n>-<n>`.
    results.append((label.replacingOccurrences(of: "[0-9]+", with: "<n>", options: .regularExpression), ms, cpu))
    sent.removeAll()
    frames = 0
}

func deliver(_ json: String, limit: Double) -> (Double, Double, String?) {
    timed(limit) { _ = global.forProperty("handle").call(withArguments: [json]) }
}

let (evaluateMs, evaluateCpu, evaluateStopped) = timed(activationLimit) {
    context.evaluateScript(script, withSourceURL: URL(fileURLWithPath: scriptPath))
}
report(0, "evaluate", evaluateMs, evaluateCpu, evaluateStopped ?? (global.forProperty("handle").isObject ? nil : "the script did not define handle"))
if !failed {
    let activate = #"{"jsonrpc":"2.0","id":0,"method":"alas/activate","params":{"api":4,"project":{"id":"p1","name":"Project"},"grants":["workspace.read","worktree.switch","session.focus","session.read","tasks.start"]}}"#
    let (ms, cpu, stopped) = deliver(activate, limit: activationLimit)
    report(0, "alas/activate", ms, cpu, stopped)
}
for (i, line) in lines.enumerated() where !failed {
    let json = resolve(line)
    let (ms, cpu, stopped) = deliver(json, limit: callLimit)
    report(i + 1, label(json), ms, cpu, stopped)
}

print("\nper kind of call, wall time (CPU time):")
var kinds: [String] = []
for r in results where !kinds.contains(r.label) { kinds.append(r.label) }
for kind in kinds {
    let calls = results.filter { $0.label == kind }
    let wall = calls.map(\.ms).sorted(), cpu = calls.map(\.cpu).sorted()
    let p = { (times: [Double], q: Double) in times[min(times.count - 1, Int(Double(times.count) * q))] }
    print("  " + pad(kind) + String(format: " n %4d  median %7.3f (%7.3f)  p99 %7.3f (%7.3f)  max %7.3f (%7.3f) ms",
        calls.count, p(wall, 0.5), p(cpu, 0.5), p(wall, 0.99), p(cpu, 0.99), wall.last!, cpu.last!))
}

if let pngPath, let frame = lastFrame {
    let provider = CGDataProvider(data: frame.pixels as CFData)!
    let image = CGImage(width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.width * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: pngPath) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    CGImageDestinationFinalize(destination)
    print("last frame written to \(pngPath)")
}
exit(failed ? 1 : 0)
