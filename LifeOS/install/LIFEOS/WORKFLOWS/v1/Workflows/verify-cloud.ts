#!/usr/bin/env bun
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { invariant } from '../../../TOOLS/Invariant';

/** Runs synthetic service-binding and timezone checks inside workerd, without deployment. */
export async function verifyCloud(binary: string): Promise<void> {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'Fixtures/cloud-probe.ts')], target: 'browser', format: 'esm' });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'arbol-cloud-'));
  invariant((await realpath(dir)).startsWith(base + '/'), 'probe directory must belong to temporary root');
  try {
    invariant(build.outputs.length === 1, 'cloud probe must bundle into one module');
    await writeFile(join(dir, 'probe.js'), await build.outputs[0].text());
    await writeFile(join(dir, 'probe.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "test", worker = (compatibilityDate = "2026-01-01", modules = [(name = "probe.js", esModule = embed "probe.js")], bindings = [(name = "COPY", service = "copy")])),
  (name = "copy", worker = (compatibilityDate = "2026-01-01", modules = [(name = "copy.js", esModule = "export default { async fetch(r) { return Response.json({success:true,output:await r.json()}) } }")])),
  (name = "internet", network = (allow = []))
 ]
);`);
    const child = Bun.spawn([resolve(binary), 'test', join(dir, 'probe.capnp'), 'test'], { stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error('workerd probe failed');
  } finally {
    invariant((await realpath(dir)).startsWith(base + '/arbol-cloud-'), 'cleanup only owns its temporary directory');
    await rm(dir, { recursive: true });
  }
}

if (import.meta.main) {
  const binary = process.argv[2];
  if (!binary) throw new Error('Usage: verify-cloud.ts <path-to-workerd>');
  await verifyCloud(binary);
}
