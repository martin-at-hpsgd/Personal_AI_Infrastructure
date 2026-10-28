import { NextResponse } from "next/server"
import fs from 'fs'
import path from 'path'
import { TELOS_DIR } from '@/lib/telos-data'
import { appendUpdateLog, backupBeforeSave, changedAutomatedRegions, confinedPath, crossOriginRefusal, withTelosLock } from '@/lib/write-guard'

// TELOS_DIR is the USER TELOS directory discovery scans (lib/telos-data.ts).

export async function POST(request: Request) {
  try {
    // A page on another origin can POST here without a preflight; only the dashboard's own page may write.
    const refusal = crossOriginRefusal(request.headers)
    if (refusal) {
      return NextResponse.json({ error: `Cross-origin write refused: ${refusal}` }, { status: 403 })
    }

    const { filename, content } = await request.json()

    if (!filename || typeof filename !== 'string' || typeof content !== 'string') {
      return NextResponse.json(
        { error: "Filename and content are required" },
        { status: 400 }
      )
    }

    // Discovery names CSV files `data/<file>.csv` and markdown files `<file>.md`,
    // both relative to TELOS_DIR, so the filename joins TELOS_DIR as given. Only
    // those two kinds are ever listed, so only those two are ever saved.
    if (!filename.endsWith('.md') && !filename.endsWith('.csv')) {
      return NextResponse.json({ error: "Only .md and .csv files can be saved" }, { status: 400 })
    }
    const baseDir = TELOS_DIR

    // Contain the path to baseDir with symlinks dereferenced (TELOS_DIR itself
    // sits behind one) — a filename like `../../.claude/.env`, or a link inside
    // the directory, is rejected before any existsSync/write touches disk.
    let realTarget: string
    try {
      if (!fs.existsSync(baseDir)) {
        return NextResponse.json({ error: `File ${filename} does not exist` }, { status: 404 })
      }
      realTarget = confinedPath(baseDir, filename)
    } catch {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      )
    }

    // Verify file exists before overwriting
    if (!fs.existsSync(realTarget)) {
      return NextResponse.json(
        { error: `File ${filename} does not exist` },
        { status: 404 }
      )
    }
    realTarget = fs.realpathSync(realTarget)
    const realBase = fs.realpathSync(baseDir)
    if (!realTarget.startsWith(realBase + path.sep)) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      )
    }

    // Hold the shared TELOS lock across the read, the check and the write, refuse
    // a hand edit of a machine-owned AUTOMATED region, and back up before writing.
    const target = realTarget
    const locked = withTelosLock(target, () => {
      const changed = changedAutomatedRegions(fs.readFileSync(target, 'utf-8'), content)
      if (changed.length > 0) return { changed }
      const backup = backupBeforeSave(baseDir, target)
      fs.writeFileSync(target, content, 'utf-8')
      return { backup }
    })
    if (!locked.ran) {
      return NextResponse.json(
        { error: `${filename} is being written by another TELOS writer (lock ${path.basename(locked.lockPath)}); nothing was saved. Retry once it finishes.` },
        { status: 409 }
      )
    }
    if ('changed' in locked.value) {
      return NextResponse.json(
        { error: `The AUTOMATED ${locked.value.changed.join(', ')} region of ${filename} is machine-owned and changes only through UpdateTelos --region; nothing was saved.` },
        { status: 409 }
      )
    }

    // Log the edit
    const timestamp = new Date().toISOString()
    const logMessage = `\n## ${timestamp}\n\n- **Action:** File edited via dashboard\n- **File:** ${filename}\n- **Backup:** Backups/${locked.value.backup}\n`

    // The save has landed either way; a changelog line that could not be written is reported, not hidden.
    const logged = appendUpdateLog(TELOS_DIR, logMessage)

    return NextResponse.json({
      success: true,
      message: `${filename} saved successfully`,
      logged,
      ...(logged ? {} : { warning: `The save landed, but its updates.md line was not written; add it by hand:${logMessage}` }),
    })
  } catch (error) {
    console.error("Error saving file:", error)
    return NextResponse.json(
      { error: "Failed to save file" },
      { status: 500 }
    )
  }
}
