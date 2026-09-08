import path from "path"
import os from "os"
import { buildRemoteConfig } from "../../src/config.js"
import type { Connection } from "../../src/connection-manager.js"
import { ManifestManager } from "../../src/manifest.js"
import { PathMapper } from "../../src/path-mapper.js"
import { SyncEngine } from "../../src/sync-engine.js"
import type { SSHPool } from "../../src/ssh-pool.js"

export async function createTestConnection(
  sshPool: SSHPool,
  root = "/home/test/project"
): Promise<Connection> {
  const config = buildRemoteConfig("ssh test@127.0.0.1", root, {
    mirrorRoot: path.join(os.tmpdir(), "mcp-remote-code-test-mirrors"),
  })
  const pathMapper = new PathMapper(config)
  const manifest = new ManifestManager(pathMapper)
  await manifest.load()
  const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

  return {
    name: "test",
    transport: "ssh",
    config,
    sshPool,
    pathMapper,
    manifest,
    syncEngine,
    remotePlatform: "linux",
    isGitRepo: false,
  }
}
