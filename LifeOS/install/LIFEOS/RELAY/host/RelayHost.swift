// RelayHost — the text line's macOS app identity.
//
// launchd runs this inside "LifeOS Relay.app"; it runs the bridge (`bun index.ts`) as a child.
// macOS attributes privacy access to the app a process tree descends from, so the grants this
// app holds (Contacts, Calendars, Reminders, Photos, control of other apps) cover every tool the
// text line runs. A bare launchd `bun` has no identity to grant, which is why a texted
// "add that number to my contact" failed on 2026-10-16.
//
//   RelayHost -- <program> [args...]   run the bridge as a child (how launchd starts it)
//   RelayHost --request <file>         ask for each grant not yet asked, then write the states (run through `open`)
//   RelayHost --status <file>          write each grant's state as JSON (run it through `open`)
import Contacts
import EventKit
import Foundation
import Photos

func contactsState() -> String {
  switch CNContactStore.authorizationStatus(for: .contacts) {
  case .authorized: return "granted"
  case .limited: return "limited"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-asked"
  @unknown default: return "unknown"
  }
}

func eventState(_ type: EKEntityType) -> String {
  switch EKEventStore.authorizationStatus(for: type) {
  case .fullAccess: return "granted"
  case .writeOnly: return "write-only"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-asked"
  @unknown default: return "unknown"
  }
}

func photosState() -> String {
  switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
  case .authorized: return "granted"
  case .limited: return "limited"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-asked"
  @unknown default: return "unknown"
  }
}

func states() -> [String: String] {
  ["contacts": contactsState(), "calendars": eventState(.event), "reminders": eventState(.reminder), "photos": photosState()]
}

/// Ask, one after another, for every grant macOS has not been asked about, then call `done`. macOS shows
/// these prompts only to an app opened through LaunchServices (`open`), never to the launchd copy, so this
/// runs from `--request`; the grants are keyed to the app, so the launchd copy holds them afterwards.
func requestMissing(_ done: @escaping () -> Void) {
  let events = EKEventStore()
  var steps: [(@escaping () -> Void) -> Void] = []
  if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
    steps.append { next in CNContactStore().requestAccess(for: .contacts) { _, _ in next() } }
  }
  if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
    steps.append { next in events.requestFullAccessToEvents { _, _ in next() } }
  }
  if EKEventStore.authorizationStatus(for: .reminder) == .notDetermined {
    steps.append { next in events.requestFullAccessToReminders { _, _ in next() } }
  }
  if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
    steps.append { next in PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in next() } }
  }
  func run(_ i: Int) {
    guard i < steps.count else { return done() }
    steps[i]({ DispatchQueue.main.async { run(i + 1) } })
  }
  run(0)
}

func writeStates(_ path: String?) {
  let data = try! JSONSerialization.data(withJSONObject: states(), options: [.sortedKeys])
  if let path { FileManager.default.createFile(atPath: path, contents: data) } else { print(String(data: data, encoding: .utf8)!) }
}

let argv = Array(CommandLine.arguments.dropFirst())

if argv.first == "--status" {
  writeStates(argv.count > 1 ? argv[1] : nil)
  exit(0)
}

if argv.first == "--request" {
  requestMissing { writeStates(argv.count > 1 ? argv[1] : nil); exit(0) }
  dispatchMain()
}

guard argv.first == "--", argv.count > 1 else {
  FileHandle.standardError.write("usage: RelayHost -- <program> [args...] | RelayHost --status [file]\n".data(using: .utf8)!)
  exit(64)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: argv[1])
child.arguments = Array(argv.dropFirst(2))
child.terminationHandler = { p in exit(p.terminationStatus) }

// launchd stops the job with SIGTERM; pass it on so the bridge shuts down cleanly.
var forwarders: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler { if child.isRunning { kill(child.processIdentifier, sig) } }
  src.resume()
  forwarders.append(src)
}

do { try child.run() } catch {
  FileHandle.standardError.write("RelayHost: cannot start \(argv[1]): \(error)\n".data(using: .utf8)!)
  exit(70)
}
FileHandle.standardError.write("RelayHost: grants \(states())\n".data(using: .utf8)!)
dispatchMain()
