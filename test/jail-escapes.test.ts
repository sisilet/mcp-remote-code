import { test } from "node:test"
import assert from "node:assert/strict"
import { isUnderRoot } from "../src/root-jail.ts"

/**
 * The jail's final decision is isUnderRoot() applied to a fully resolved path.
 * These cover the shapes that a resolved symlink or traversal produces.
 * End-to-end escape behaviour against a real server with symlinks is covered
 * by the fixture in scripts/smoke.mjs and was verified manually 2026-09-06:
 * absolute symlink, relative symlink, and directory-symlink escapes were all
 * refused, as were plain traversal and an absolute path outside the root.
 */
test("resolved escapes are refused", () => {
  const root = "/srv/project"
  for (const resolved of [
    "/etc/passwd",
    "/srv/other/secret.txt",
    "/srv/projectile/x",   // sibling sharing a prefix
    "/srv",                 // parent
    "/",
  ]) {
    assert.equal(isUnderRoot(root, resolved), false, `should refuse ${resolved}`)
  }
})

test("resolved paths inside the root are allowed", () => {
  const root = "/srv/project"
  for (const resolved of ["/srv/project", "/srv/project/a.txt", "/srv/project/sub/deep/b"]) {
    assert.equal(isUnderRoot(root, resolved), true, `should allow ${resolved}`)
  }
})

test("root '/' allows everything but is still well-formed", () => {
  assert.equal(isUnderRoot("/", "/etc/passwd"), true)
  assert.equal(isUnderRoot("/", "/"), true)
})
