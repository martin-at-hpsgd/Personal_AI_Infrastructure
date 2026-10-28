// ContactsCli — deterministic CNContactStore I/O for the ContactPhotos skill.
// Subcommands:
//   audit                      → full JSON audit of every unified contact (no image bytes) to stdout
//   backup <dir>               → save every existing contact image + manifest.json into <dir>
//   set <contactId> <imgPath>  → set one contact's imageData, verify by re-fetch
//   apply <plan.jsonl>         → batch-apply {"id":..., "imagePath":...} rows; per-row result JSONL to stdout
//   restore <backupDir> [id..] → restore imageData from a backup dir (all, or listed ids)
//   create <json|->            → create one card from an IdentityFields object; prints {"id":"…"}
//   update <id> <json|->       → replace only the identity fields present in the patch; prints the new row
// Requires the Contacts TCC grant for the invoking terminal app.
//
// WRITE SCOPE (People ISA). create/update touch identity fields only — name parts,
// nickname, organization, contact type, emails, phones, postal addresses, urls. A patch key
// outside that set is refused with exit 3 and nothing is written. There is deliberately NO
// delete subcommand and no call to CNSaveRequest.delete anywhere in this file: a card removed
// by a sync bug is the one irreversible outcome on the Apple side. Photo bytes stay with the
// `set` / `apply` path, so `hasPhoto` is refused as read-only here.

import Contacts
import Foundation

func die(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

// Declared before the helpers below reference it: top-level code initializes in textual order.
let args = CommandLine.arguments

let store = CNContactStore()
func requestAccess() {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    store.requestAccess(for: .contacts) { ok, _ in granted = ok; sem.signal() }
    sem.wait()
    if !granted { die("DENIED: Contacts access not granted (grant the terminal app Contacts access in System Settings → Privacy & Security)") }
}

let baseKeys: [CNKeyDescriptor] = [
    CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey, CNContactNicknameKey,
    CNContactOrganizationNameKey, CNContactImageDataAvailableKey, CNContactIdentifierKey,
    CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactTypeKey, CNContactUrlAddressesKey,
    CNContactPostalAddressesKey
] as [CNKeyDescriptor]
let imageKeys: [CNKeyDescriptor] = baseKeys + [CNContactImageDataKey as CNKeyDescriptor, CNContactThumbnailImageDataKey as CNKeyDescriptor]

// ── identity write scope (ISC-13) ─────────────────────────────────────────────
// Mirrors IDENTITY_FIELDS in LIFEOS/PEOPLE/types.ts. Keep the two in step.
let identityKeys: Set<String> = [
    "name", "givenName", "familyName", "nickname", "org", "isOrganization",
    "emails", "phones", "addresses", "urls", "hasPhoto"
]
// hasPhoto is identity but not writable here: photo bytes go through `set`/`apply`.
let readOnlyIdentityKeys: Set<String> = ["hasPhoto"]

/// Apple's label constants → the plain names the store uses ("home" | "work" | "other").
func labelName(_ raw: String?) -> String {
    guard let r = raw, !r.isEmpty else { return "" }
    switch r {
    case CNLabelHome: return "home"
    case CNLabelWork: return "work"
    case CNLabelOther: return "other"
    default: return CNLabeledValue<NSString>.localizedString(forLabel: r)
    }
}

/// The inverse. Anything unrecognized becomes CNLabelOther rather than an invented label.
func labelConstant(_ name: String?) -> String {
    switch (name ?? "").lowercased() {
    case "home": return CNLabelHome
    case "work": return CNLabelWork
    default: return CNLabelOther
    }
}

func postalRow(_ lv: CNLabeledValue<CNPostalAddress>) -> [String: Any] {
    let a = lv.value
    return ["label": labelName(lv.label), "street": a.street, "city": a.city,
            "state": a.state, "postalCode": a.postalCode, "country": a.country]
}

// Stored imageData can be garbage: sync services have written S3 "AccessDenied" XML error
// bodies as photos. imageDataAvailable is true for any
// bytes, so validity must be checked against real image magic bytes.
func isRealImage(_ d: Data) -> Bool {
    guard d.count >= 12 else { return false }
    let b = [UInt8](d.prefix(12))
    if b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF { return true } // JPEG
    if b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 { return true } // PNG
    if b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 { return true } // GIF
    if b[0] == 0x42 && b[1] == 0x4D { return true } // BMP
    if b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70 { return true } // HEIC/HEIF ftyp box
    return false
}

func contactRow(_ c: CNContact) -> [String: Any] {
    var e: [String: Any] = [:]
    e["id"] = c.identifier
    e["name"] = "\(c.givenName) \(c.familyName)".trimmingCharacters(in: .whitespaces)
    e["givenName"] = c.givenName
    e["familyName"] = c.familyName
    e["nickname"] = c.nickname
    e["org"] = c.organizationName
    e["type"] = c.contactType == .organization ? "org" : "person"
    // hasImage means a VALID image when bytes are loaded; garbage bytes report false + imageInvalid
    if c.isKeyAvailable(CNContactImageDataKey) {
        let valid = c.imageData.map(isRealImage) ?? false
        e["hasImage"] = valid
        if c.imageDataAvailable && !valid { e["imageInvalid"] = true; e["imageBytes"] = c.imageData?.count ?? 0 }
    } else {
        e["hasImage"] = c.imageDataAvailable
    }
    e["emails"] = c.emailAddresses.map { ($0.value as String).lowercased() }
    e["phones"] = c.phoneNumbers.map { $0.value.stringValue }
    e["urls"] = c.urlAddresses.map { $0.value as String }
    e["addresses"] = c.postalAddresses.map(postalRow)
    return e
}

// ── identity writes (create / update) ─────────────────────────────────────────

/// Refuses a patch that reaches outside the identity set, before anything is written.
/// Exit 3 is the typed refusal both the Swift CLI and LIFEOS/PEOPLE/apple.ts use.
func assertIdentityOnly(_ patch: [String: Any]) {
    let keys = Set(patch.keys)
    let foreign = keys.subtracting(identityKeys).sorted()
    if !foreign.isEmpty {
        die("REFUSED: field(s) outside the identity set: \(foreign.joined(separator: ", "))", 3)
    }
    let readOnly = keys.intersection(readOnlyIdentityKeys).sorted()
    if !readOnly.isEmpty {
        die("REFUSED: read-only identity field(s): \(readOnly.joined(separator: ", ")) — photo bytes are written by `set`", 3)
    }
}

func strings(_ v: Any?) -> [String]? {
    guard let arr = v as? [Any] else { return nil }
    return arr.compactMap { $0 as? String }
}

/// Applies only the keys present in `patch`. Arrays replace wholesale — a patch that
/// carries `emails` defines the card's full email list, it does not append to it.
func applyPatch(_ patch: [String: Any], to mu: CNMutableContact) {
    if let v = patch["isOrganization"] as? Bool { mu.contactType = v ? .organization : .person }
    if let v = patch["givenName"] as? String { mu.givenName = v }
    if let v = patch["familyName"] as? String { mu.familyName = v }
    if let v = patch["nickname"] as? String { mu.nickname = v }
    if let v = patch["org"] as? String { mu.organizationName = v }
    // `name` is the display form. It is only consulted when the split fields are absent
    // from this same patch, so an explicit givenName/familyName always wins.
    if let v = patch["name"] as? String, patch["givenName"] == nil, patch["familyName"] == nil {
        if mu.contactType == .organization {
            if patch["org"] == nil { mu.organizationName = v }
        } else {
            let parts = v.split(separator: " ").map(String.init)
            if parts.count > 1 {
                mu.familyName = parts[parts.count - 1]
                mu.givenName = parts.dropLast().joined(separator: " ")
            } else {
                mu.givenName = v
                mu.familyName = ""
            }
        }
    }
    let isOrg = mu.contactType == .organization
    if let v = strings(patch["emails"]) {
        let lbl = isOrg ? CNLabelWork : CNLabelHome
        mu.emailAddresses = v.map { CNLabeledValue(label: lbl, value: $0 as NSString) }
    }
    if let v = strings(patch["phones"]) {
        let lbl = isOrg ? CNLabelPhoneNumberMain : CNLabelPhoneNumberMobile
        mu.phoneNumbers = v.map { CNLabeledValue(label: lbl, value: CNPhoneNumber(stringValue: $0)) }
    }
    if let v = strings(patch["urls"]) {
        mu.urlAddresses = v.map { CNLabeledValue(label: CNLabelURLAddressHomePage, value: $0 as NSString) }
    }
    if let v = patch["addresses"] as? [Any] {
        mu.postalAddresses = v.compactMap { raw in
            guard let d = raw as? [String: Any] else { return nil }
            let a = CNMutablePostalAddress()
            a.street = (d["street"] as? String) ?? ""
            a.city = (d["city"] as? String) ?? ""
            a.state = (d["state"] as? String) ?? ""
            a.postalCode = (d["postalCode"] as? String) ?? ""
            a.country = (d["country"] as? String) ?? ""
            return CNLabeledValue(label: labelConstant(d["label"] as? String), value: a as CNPostalAddress)
        }
    }
}

/// JSON from argv, or from stdin when the argument is absent or "-".
func readPatch(_ idx: Int) -> [String: Any] {
    let text: String
    if args.count > idx, args[idx] != "-" {
        text = args[idx]
    } else {
        text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
    guard let data = text.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let obj = parsed as? [String: Any]
    else { die("BAD JSON: expected one IdentityFields object on argv or stdin", 2) }
    return obj
}

func fetchOne(_ id: String, _ keys: [CNKeyDescriptor]) throws -> CNContact? {
    let pred = CNContact.predicateForContacts(withIdentifiers: [id])
    return try store.unifiedContacts(matching: pred, keysToFetch: keys).first
}

func fetchAll(withImages: Bool) throws -> [CNContact] {
    var all: [CNContact] = []
    let req = CNContactFetchRequest(keysToFetch: withImages ? imageKeys : baseKeys)
    req.unifyResults = true
    try store.enumerateContacts(with: req) { c, _ in all.append(c) }
    return all
}

guard args.count >= 2 else { die("usage: audit | backup <dir> | set <id> <img> | apply <plan.jsonl> | restore <dir> [ids...] | create <json|-> | update <id> <json|->", 2) }
requestAccess()

switch args[1] {
case "audit":
    var out: [String: Any] = [:]
    var containerInfo: [[String: Any]] = []
    for c in try store.containers(matching: nil) {
        let typeName: String
        switch c.type {
        case .local: typeName = "local"
        case .exchange: typeName = "exchange"
        case .cardDAV: typeName = "cardDAV"
        case .unassigned: typeName = "unassigned"
        @unknown default: typeName = "unknown"
        }
        containerInfo.append(["id": c.identifier, "name": c.name, "type": typeName])
    }
    out["containers"] = containerInfo
    // Fetch WITH image bytes so hasImage reflects validity, not mere byte presence (adds a couple of seconds on a large address book)
    let all = try fetchAll(withImages: true)
    let rows = all.map(contactRow)
    out["generatedAt"] = ISO8601DateFormatter().string(from: Date())
    out["total"] = rows.count
    out["withImage"] = rows.filter { ($0["hasImage"] as? Bool) == true }.count
    out["withoutImage"] = rows.filter { ($0["hasImage"] as? Bool) != true }.count
    out["contacts"] = rows
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

case "backup":
    guard args.count >= 3 else { die("usage: backup <dir>", 2) }
    let dir = URL(fileURLWithPath: args[2])
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("images"), withIntermediateDirectories: true)
    let all = try fetchAll(withImages: true)
    var manifest: [[String: Any]] = []
    var saved = 0
    for c in all {
        var row = contactRow(c)
        if let img = c.imageData {
            let safeId = c.identifier.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            let f = dir.appendingPathComponent("images/\(safeId).imgdata")
            try img.write(to: f)
            row["imageFile"] = "images/\(safeId).imgdata"
            row["imageBytes"] = img.count
            saved += 1
        }
        manifest.append(row)
    }
    let m: [String: Any] = ["generatedAt": ISO8601DateFormatter().string(from: Date()), "total": all.count, "imagesSaved": saved, "contacts": manifest]
    try JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]).write(to: dir.appendingPathComponent("manifest.json"))
    print("BACKUP OK: \(all.count) contacts, \(saved) images → \(dir.path)")

case "set":
    guard args.count >= 4 else { die("usage: set <contactId> <imagePath>", 2) }
    let pred = CNContact.predicateForContacts(withIdentifiers: [args[2]])
    let matches = try store.unifiedContacts(matching: pred, keysToFetch: imageKeys)
    guard matches.count == 1 else { die("EXPECTED 1 contact for id, got \(matches.count)", 4) }
    let img = try Data(contentsOf: URL(fileURLWithPath: args[3]))
    let mutable = matches[0].mutableCopy() as! CNMutableContact
    mutable.imageData = img
    let req = CNSaveRequest()
    req.update(mutable)
    try store.execute(req)
    let check = try store.unifiedContacts(matching: pred, keysToFetch: [CNContactImageDataAvailableKey as CNKeyDescriptor])
    print("SET OK id=\(args[2]) bytes=\(img.count) verified=\(check.first?.imageDataAvailable ?? false)")

case "apply":
    guard args.count >= 3 else { die("usage: apply <plan.jsonl>", 2) }
    let lines = try String(contentsOfFile: args[2], encoding: .utf8).split(separator: "\n")
    var rows: [(id: String, path: String)] = []
    for l in lines {
        guard let d = try JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
              let id = d["id"] as? String, let p = d["imagePath"] as? String else { continue }
        rows.append((id, p))
    }
    var applied = 0, failed = 0
    // Per-contact saves with retry/backoff. contactsd rejects sustained batch writes
    // (Cocoa error 134092) once iCloud sync churn starts — small writes + pacing survive it.
    let saveKeys: [CNKeyDescriptor] = [CNContactImageDataAvailableKey, CNContactImageDataKey] as [CNKeyDescriptor]
    func saveOne(_ id: String, _ path: String) -> String? { // returns error string or nil on success
        let attempts: [UInt32] = [0, 1, 3] // seconds of sleep BEFORE each attempt
        var lastErr = "unknown"
        for (i, delay) in attempts.enumerated() {
            if delay > 0 { sleep(delay) }
            do {
                let pred = CNContact.predicateForContacts(withIdentifiers: [id])
                guard let c = try store.unifiedContacts(matching: pred, keysToFetch: saveKeys).first else { return "contact not found" }
                guard let img = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return "image unreadable" }
                if c.imageDataAvailable, let existing = c.imageData, isRealImage(existing), i == 0 {
                    // already has a VALID image (e.g. re-run of a partially applied plan) — leave it.
                    // Garbage bytes (imageDataAvailable but invalid) fall through and get overwritten.
                    return nil
                }
                let mu = c.mutableCopy() as! CNMutableContact
                mu.imageData = img
                let req = CNSaveRequest()
                req.update(mu)
                try store.execute(req)
                let check = try store.unifiedContacts(matching: pred, keysToFetch: [CNContactImageDataAvailableKey as CNKeyDescriptor])
                if check.first?.imageDataAvailable == true { return nil }
                lastErr = "post-save fetch shows no image"
            } catch {
                lastErr = "save failed: \(error.localizedDescription)"
            }
        }
        return lastErr
    }
    for (n, r) in rows.enumerated() {
        if let err = saveOne(r.id, r.path) {
            print("{\"id\":\"\(r.id)\",\"ok\":false,\"err\":\"\(err)\"}"); failed += 1
        } else {
            print("{\"id\":\"\(r.id)\",\"ok\":true}"); applied += 1
        }
        usleep(300_000) // 300ms pacing between contacts
        if (n + 1) % 100 == 0 {
            FileHandle.standardError.write("• applied \(n + 1)/\(rows.count) — breathing 20s\n".data(using: .utf8)!)
            sleep(20) // let contactsd/iCloud digest before the next hundred
        }
    }
    FileHandle.standardError.write("APPLY DONE applied=\(applied) failed=\(failed)\n".data(using: .utf8)!)

case "restore":
    guard args.count >= 3 else { die("usage: restore <backupDir> [ids...]", 2) }
    let dir = URL(fileURLWithPath: args[2])
    let mdata = try Data(contentsOf: dir.appendingPathComponent("manifest.json"))
    guard let manifest = try JSONSerialization.jsonObject(with: mdata) as? [String: Any],
          let contacts = manifest["contacts"] as? [[String: Any]] else { die("bad manifest") }
    let onlyIds = Set(args.dropFirst(3))
    var restored = 0
    for row in contacts {
        guard let id = row["id"] as? String, let f = row["imageFile"] as? String else { continue }
        if !onlyIds.isEmpty && !onlyIds.contains(id) { continue }
        let pred = CNContact.predicateForContacts(withIdentifiers: [id])
        guard let c = try store.unifiedContacts(matching: pred, keysToFetch: imageKeys).first else { continue }
        let mu = c.mutableCopy() as! CNMutableContact
        mu.imageData = try Data(contentsOf: dir.appendingPathComponent(f))
        let req = CNSaveRequest()
        req.update(mu)
        try store.execute(req)
        restored += 1
    }
    print("RESTORE OK: \(restored) images restored")

case "create":
    let patch = readPatch(2)
    assertIdentityOnly(patch)
    let named = ["name", "givenName", "familyName", "org"].contains { (patch[$0] as? String)?.isEmpty == false }
    guard named else { die("REFUSED: create needs one of name, givenName, familyName, org", 2) }
    let mu = CNMutableContact()
    applyPatch(patch, to: mu)
    let req = CNSaveRequest()
    req.add(mu, toContainerWithIdentifier: nil) // nil = the default container
    try store.execute(req)
    guard let saved = try fetchOne(mu.identifier, baseKeys) else {
        die("CREATE FAILED: card not readable after save (id \(mu.identifier))", 4)
    }
    let created = try JSONSerialization.data(withJSONObject: ["id": saved.identifier], options: [.sortedKeys])
    print(String(data: created, encoding: .utf8)!)

case "update":
    guard args.count >= 3 else { die("usage: update <contactId> <json|->", 2) }
    let id = args[2]
    let patch = readPatch(3)
    assertIdentityOnly(patch)
    guard !patch.isEmpty else { die("REFUSED: empty patch", 2) }
    guard let existing = try fetchOne(id, baseKeys) else { die("NOT FOUND: no contact with id \(id)", 4) }
    let mu = existing.mutableCopy() as! CNMutableContact
    applyPatch(patch, to: mu)
    let req = CNSaveRequest()
    req.update(mu)
    try store.execute(req)
    guard let after = try fetchOne(id, baseKeys) else { die("UPDATE FAILED: card unreadable after save (id \(id))", 4) }
    let row = try JSONSerialization.data(withJSONObject: contactRow(after), options: [.sortedKeys])
    print(String(data: row, encoding: .utf8)!)

default:
    die("unknown subcommand \(args[1])", 2)
}
