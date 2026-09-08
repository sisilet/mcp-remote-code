import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
/** OpenSSH-style fingerprint: SHA256 base64, no padding. */
export function fingerprintOf(key) {
    const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
}
export function knownHostsPath() {
    return process.env.MCP_KNOWN_HOSTS || path.join(os.homedir(), ".ssh", "known_hosts");
}
/** The name ssh uses in known_hosts: bare host on port 22, [host]:port otherwise. */
export function knownHostsName(host, port) {
    return !port || port === 22 ? host : `[${host}]:${port}`;
}
/**
 * Base64 key blobs recorded for this host, or [] when unknown.
 * Never throws: a missing known_hosts or absent ssh-keygen yields [].
 */
export function lookupKnownHostKeys(host, port) {
    const name = knownHostsName(host, port);
    const file = knownHostsPath();
    try {
        const out = execFileSync("ssh-keygen", ["-f", file, "-F", name], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return out
            .split("\n")
            .filter((line) => line.trim() && !line.startsWith("#"))
            .map((line) => line.trim().split(/\s+/))
            // marker lines (@cert-authority, @revoked) shift the columns; skip them
            .filter((f) => f.length >= 3 && !f[0].startsWith("@"))
            .map((f) => f[2]);
    }
    catch {
        return [];
    }
}
/** Compare the key offered by the server against known_hosts. */
export function checkHostKey(host, port, key) {
    const fingerprint = fingerprintOf(key);
    const offered = key.toString("base64");
    const known = lookupKnownHostKeys(host, port);
    if (known.length === 0)
        return { ok: false, unknown: true, fingerprint };
    if (known.includes(offered))
        return { ok: true, fingerprint };
    // Known host, unrecorded key: rotated key, or impersonation. Refuse either way.
    return { ok: false, mismatch: true, fingerprint };
}
export function unknownHostMessage(host, port, fingerprint) {
    const name = knownHostsName(host, port);
    return [
        `Host ${name} is not in ${knownHostsPath()}.`,
        `Offered key fingerprint: ${fingerprint}`,
        ``,
        `If you trust it, record the key:`,
        `  ssh-keyscan -p ${port || 22} ${host} >> ${knownHostsPath()}`,
        `and verify the fingerprint matches the one above before reconnecting.`,
        `Or set "hostKeyPolicy": "accept-new" on this target to record it on first use.`,
    ].join("\n");
}
export function mismatchMessage(host, port, fingerprint) {
    const name = knownHostsName(host, port);
    return [
        `HOST KEY MISMATCH for ${name}.`,
        `Offered key fingerprint: ${fingerprint}`,
        `This matches no key recorded in ${knownHostsPath()}.`,
        ``,
        `Either the host's key changed legitimately, or the connection is being intercepted.`,
        `Verify out of band, then remove the stale entry:`,
        `  ssh-keygen -R ${knownHostsName(host, port)} -f ${knownHostsPath()}`,
    ].join("\n");
}
/** Append a newly accepted key, for hostKeyPolicy "accept-new". */
export function recordHostKey(host, port, key, keyType) {
    const line = `${knownHostsName(host, port)} ${keyType} ${key.toString("base64")}\n`;
    fs.appendFileSync(knownHostsPath(), line, { mode: 0o600 });
}
//# sourceMappingURL=known-hosts.js.map