import { NextResponse } from "next/server"
import fs from 'fs'
import path from 'path'
import { TELOS_DIR } from '@/lib/telos-data'
import { appendUpdateLog, confinedPath, crossOriginRefusal } from '@/lib/write-guard'

// TELOS_DIR is the USER TELOS directory discovery scans (lib/telos-data.ts).

export async function POST(request: Request) {
  try {
    // A multipart POST from any web page open in the browser is a simple request
    // with no preflight; only the dashboard's own page may write here.
    const refusal = crossOriginRefusal(request.headers)
    if (refusal) {
      return NextResponse.json({ error: `Cross-origin write refused: ${refusal}` }, { status: 403 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      )
    }

    // Validate file type
    const fileName = file.name
    if (path.basename(fileName) !== fileName || fileName.startsWith('.')) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      )
    }
    const isMarkdown = fileName.endsWith('.md')
    const isCSV = fileName.endsWith('.csv')

    if (!isMarkdown && !isCSV) {
      return NextResponse.json(
        { error: "Only .md and .csv files are allowed" },
        { status: 400 }
      )
    }

    // Read file content
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Ensure TELOS directory exists
    if (!fs.existsSync(TELOS_DIR)) {
      fs.mkdirSync(TELOS_DIR, { recursive: true })
    }

    // Determine save path. CSV files go in the data subdirectory, MD files in
    // the root. The path is contained to TELOS_DIR with symlinks dereferenced:
    // a `data` entry that is a link out of the directory must not take the write.
    let savePath: string
    try {
      if (isCSV) {
        const csvDir = path.join(TELOS_DIR, 'data')
        if (!fs.existsSync(csvDir)) {
          fs.mkdirSync(csvDir, { recursive: true })
        }
      }
      savePath = confinedPath(TELOS_DIR, isCSV ? path.join('data', fileName) : fileName)
    } catch {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      )
    }

    // Save file. Flag wx creates the file only if nothing is there, a dangling
    // symlink included, so an existing file is never overwritten and a planted
    // link is never followed to its target.
    try {
      fs.writeFileSync(savePath, buffer, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return NextResponse.json(
          { error: `File ${fileName} already exists. Please delete the existing file first or rename your file.` },
          { status: 409 }
        )
      }
      throw e
    }

    // Log the upload
    const timestamp = new Date().toISOString()
    const logMessage = `\n## ${timestamp}\n\n- **Action:** File uploaded via dashboard\n- **File:** ${fileName}\n- **Type:** ${isCSV ? 'CSV' : 'Markdown'}\n- **Path:** ${savePath}\n`

    // The file has landed either way; a changelog line that could not be written is reported, not hidden.
    const logged = appendUpdateLog(TELOS_DIR, logMessage)

    return NextResponse.json({
      success: true,
      message: `${fileName} uploaded successfully to ${isCSV ? 'data/' : ''}`,
      path: savePath,
      logged,
      ...(logged ? {} : { warning: `The upload landed, but its updates.md line was not written; add it by hand:${logMessage}` }),
    })
  } catch (error) {
    console.error("Error in upload API:", error)
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    )
  }
}
