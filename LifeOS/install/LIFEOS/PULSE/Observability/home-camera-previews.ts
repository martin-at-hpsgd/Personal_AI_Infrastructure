import { execFile } from "node:child_process";
import sharp from "sharp";

type Frame = { x: number; y: number; width: number; height: number };
type Tile = { identifier: string; name: string; frame: Frame };
export type CameraPreview = { id: string; name: string; sourceAge: string; image: string };
type PreviewResult = { ok: boolean; capturedAt: string; cameras: CameraPreview[]; error?: string };
const CAMERA_PREFIX = "HomeApp.Dashboard.Cameras.MosaicCell.";
const headers = { "Cache-Control": "no-store", "CDN-Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };

// Interceptor's generic screenshot has an implicit fallback. This native script
// instead binds screencapture to a concrete Home window ID; an absent ID fails.
// All output remains local; the private temporary file is removed before return.
const EXACT_HOME_CAPTURE = String.raw`
ObjC.import("Foundation"); ObjC.import("CoreGraphics");
ObjC.bindFunction("kill", ["int", ["int", "int"]]);
function invariant(ok, message) { if (!ok) throw new Error(message); }
function waitFor(task, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (task.isRunning && Date.now() < deadline) $.NSThread.sleepForTimeInterval(0.02);
  return !task.isRunning;
}
function windows() {
  return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)))
    .filter(w => w.kCGWindowOwnerName === "Home" && w.kCGWindowName === "Cameras");
}
const before = windows();
invariant(before.length === 1, "Open exactly one Home Cameras window");
const win = before[0];
invariant(Number.isInteger(win.kCGWindowNumber) && win.kCGWindowNumber > 0, "Invalid Home window ID");
const root = $.NSTemporaryDirectory().js;
const directory = root + "pulse-camera-" + $.NSUUID.UUID.UUIDString.js;
const path = directory + "/frame.jpg";
const fm = $.NSFileManager.defaultManager;
invariant(fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(directory, false, $({NSFilePosixPermissions:448}), null), "Cannot create private capture directory");
let output;
try {
  const task = $.NSTask.alloc.init;
  task.launchPath = "/usr/sbin/screencapture";
  task.arguments = ["-x", "-o", "-l", String(win.kCGWindowNumber), "-t", "jpg", path];
  task.standardError = $.NSPipe.pipe;
  task.launch;
  if (!waitFor(task, 3000)) {
    task.terminate;
    if (!waitFor(task, 200)) {
      invariant(task.processIdentifier > 0, "Invalid capture process");
      $.kill(task.processIdentifier, 9);
      waitFor(task, 500);
    }
    throw new Error("Home capture timed out");
  }
  invariant(task.terminationStatus === 0, "Home window capture failed");
  const after = windows();
  invariant(after.length === 1 && after[0].kCGWindowNumber === win.kCGWindowNumber && after[0].kCGWindowOwnerPID === win.kCGWindowOwnerPID, "Home window changed");
  const data = $.NSData.dataWithContentsOfFile(path);
  invariant(data && data.length > 0, "Empty Home capture");
  output = JSON.stringify({windowId:win.kCGWindowNumber, pid:win.kCGWindowOwnerPID, bounds:win.kCGWindowBounds, dataUrl:"data:image/jpeg;base64," + data.base64EncodedStringWithOptions(0).js});
} finally {
  invariant(fm.removeItemAtPathError(directory, null), "Capture cleanup failed");
}
output;
`;

function command(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("interceptor", ["macos", ...args], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Apple Home preview access unavailable"));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid Apple Home capture response")); }
    });
  });
}

export function cropBox(tile: Frame, window: Frame, width: number, height: number) {
  const values = [...Object.values(tile), ...Object.values(window), width, height];
  if (!values.every(Number.isFinite) || window.width <= 0 || window.height <= 0 || tile.width <= 0 || tile.height <= 0) throw new Error("Invalid camera bounds");
  // A resized window or off-screen/clipped tile is not a valid camera image.
  if (Math.abs(width / height - window.width / window.height) > 0.005) throw new Error("Camera window changed size");
  const left = Math.ceil((tile.x - window.x) * width / window.width);
  const top = Math.ceil((tile.y - window.y) * height / window.height);
  const cropWidth = Math.floor(tile.width * width / window.width) - 2;
  const cropHeight = Math.floor(tile.height * height / window.height) - 2;
  if (left < 0 || top < 0 || cropWidth < 80 || cropHeight < 45 || left + cropWidth > width || top + cropHeight > height) throw new Error("Keep all camera previews visible in Home");
  return { left, top, width: cropWidth, height: cropHeight };
}

async function viewState() {
  const windows = await command(["windows", "--app", "Home"]);
  if (!Array.isArray(windows) || windows.length !== 1 || windows[0].title !== "Cameras") throw new Error("Open the Cameras overview in Apple Home to refresh previews.");
  const found = await command(["find", CAMERA_PREFIX, "--app", "Home"]);
  const tiles: Tile[] = (Array.isArray(found) ? found : []).filter(t => typeof t.identifier === "string" && t.identifier.startsWith(CAMERA_PREFIX) && t.frame);
  if (!tiles.length) throw new Error("No camera previews visible in Apple Home.");
  if (tiles.length >= 25) throw new Error("Camera discovery reached its limit; narrow the Home camera overview.");
  return { window: windows[0].frame as Frame, tiles };
}

const frameKey = (f: Frame) => [f.x, f.y, f.width, f.height];
const signature = (state: Awaited<ReturnType<typeof viewState>>) => JSON.stringify([frameKey(state.window), state.tiles.map(t => [t.identifier, frameKey(t.frame)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);

async function capture(): Promise<PreviewResult> {
  try {
    const before = await viewState();
    const envelope = await command(["script", "run", "--jxa", EXACT_HOME_CAPTURE]);
    const shot = JSON.parse(envelope.result);
    const after = await viewState();
    if (signature(before) !== signature(after)) throw new Error("Home camera layout changed. Waiting for the next refresh.");
    if (!shot.windowId || !shot.pid || !shot.bounds || frameKey(before.window).some((v, i) => Math.abs(v - [shot.bounds.X, shot.bounds.Y, shot.bounds.Width, shot.bounds.Height][i]) > 1)) throw new Error("Camera window identity mismatch");
    if (typeof shot.dataUrl !== "string" || !shot.dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("Camera capture unavailable");
    const pixels = Buffer.from(shot.dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    const metadata = await sharp(pixels).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Empty camera capture");
    const cameras = await Promise.all(after.tiles.map(async tile => {
      const box = cropBox(tile.frame, after.window, metadata.width!, metadata.height!);
      const image = await sharp(pixels).extract(box).resize({ width: 720, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      const parts = tile.name.split(", ");
      return { id: tile.identifier.slice(CAMERA_PREFIX.length), name: parts.slice(1, -1).join(", "), sourceAge: parts.at(-1) ?? "unknown", image: `data:image/jpeg;base64,${image.toString("base64")}` };
    }));
    return { ok: true, capturedAt: new Date().toISOString(), cameras };
  } catch (error) {
    return { ok: false, capturedAt: new Date().toISOString(), cameras: [], error: error instanceof Error ? error.message : "Camera previews unavailable" };
  }
}

let cached: PreviewResult | undefined;
let pending: Promise<PreviewResult> | undefined;
export function permittedPreviewRequest(req: Request): boolean {
  const url = new URL(req.url);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && req.headers.get("x-pulse-camera-preview") === "1"
    && (!req.headers.has("origin") || req.headers.get("origin") === url.origin)
    && (!req.headers.has("sec-fetch-site") || req.headers.get("sec-fetch-site") === "same-origin")
    && process.env.LIFEOS_PULSE_BIND_ALL?.trim() !== "1";
}

export async function handleCameraPreviews(req: Request): Promise<Response> {
  if (!permittedPreviewRequest(req)) return new Response("forbidden", { status: 403, headers });
  if (!cached || Date.now() - Date.parse(cached.capturedAt) > 12000) {
    pending ??= capture().then(result => { cached = result; return result; }).finally(() => { pending = undefined; });
    await pending;
  }
  return Response.json(cached, { headers });
}
