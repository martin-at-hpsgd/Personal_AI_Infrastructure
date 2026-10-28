#!/usr/bin/env bun
/**
 * Canvas.ts — pinned entry to the mcp-excalidraw-server CLI (yctimlin, MIT).
 *
 * Pins the package version and the canvas port so every invocation across
 * sessions drives the same server. All arguments pass through unchanged;
 * see References/Cheatsheet.md for the command list.
 *
 * Usage: bun Canvas.ts <command> [...args]
 */

const PKG = "mcp-excalidraw-server@2.0.0";
const PORT = process.env.EXCALIDRAW_PORT ?? "3579";

const proc = Bun.spawn(["bunx", PKG, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    PORT,
    EXPRESS_SERVER_URL: process.env.EXPRESS_SERVER_URL ?? `http://127.0.0.1:${PORT}`,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);

export {};
