import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isUnderRoot,
  resolveUnderRoot,
  resolveUnderRootSync,
} from "../src/root-jail.js"
import { createFakeSSHPool } from "./fixtures/fake-ssh-pool.js"

const ROOT = "/home/test/project"

describe("root-jail", () => {
  it("joins relative paths under root", () => {
    const result = resolveUnderRootSync(ROOT, "hello.txt")
    assert.equal(result.path, "/home/test/project/hello.txt")
  })

  it("allows absolute paths inside root", () => {
    const result = resolveUnderRootSync(ROOT, "/home/test/project/src/main.ts")
    assert.equal(result.path, "/home/test/project/src/main.ts")
  })

  it("rejects prefix collisions like /home/projectile", () => {
    const result = resolveUnderRootSync(ROOT, "/home/test/projectile/secret.txt")
    assert.match(result.error ?? "", /outside the allowed root/)
  })

  it("rejects parent traversal", () => {
    const result = resolveUnderRootSync(ROOT, "../secret.txt")
    assert.match(result.error ?? "", /outside the allowed root/)
  })

  it("rejects symlink escape via realpath", async () => {
    const pool = createFakeSSHPool({
      realpaths: {
        "/home/test/project/escape": "/home/test/secret/outside.txt",
      },
    })
    const result = await resolveUnderRoot(ROOT, "/home/test/project/escape", pool)
    assert.match(result.error ?? "", /outside the allowed root/)
  })

  it("allows missing paths inside root with allowMissing", async () => {
    const pool = createFakeSSHPool({ realpaths: { "/home/test/project/new.txt": null } })
    const result = await resolveUnderRoot(ROOT, "/home/test/project/new.txt", pool, {
      allowMissing: true,
    })
    assert.equal(result.path, "/home/test/project/new.txt")
  })

  it("rejects new file when parent resolves outside root", async () => {
    const pool = createFakeSSHPool({
      realpaths: {
        "/home/test/secret": "/home/test/secret",
      },
    })
    const result = await resolveUnderRoot(ROOT, "/home/test/secret/new.txt", pool, {
      forNewFile: true,
    })
    assert.match(result.error ?? "", /outside the allowed root/)
  })

  it("uses strict child-prefix checks", () => {
    assert.equal(isUnderRoot("/home/proj", "/home/proj"), true)
    assert.equal(isUnderRoot("/home/proj", "/home/proj/file"), true)
    assert.equal(isUnderRoot("/home/proj", "/home/projectile"), false)
  })
})
