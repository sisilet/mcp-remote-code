/**
 * Host key verification against ~/.ssh/known_hosts (review F-4).
 *
 * ssh2 accepts ANY host key when no hostVerifier is supplied, so without this
 * the tool has no MITM protection while authenticating with private keys and
 * executing commands.
 *
 * Lookup is delegated to `ssh-keygen -F`, deliberately, rather than parsing
 * known_hosts here: it already handles hashed entries (|1|...), the
 * [host]:port form for non-standard ports, @cert-authority and @revoked
 * markers, and multiple key types per host. Reimplementing that correctly is
 * a poor use of effort and a good source of subtle bugs.
 */
export type HostKeyPolicy = "verify" | "accept-new" | "insecure";
export interface HostKeyCheck {
    ok: boolean;
    /** Host has no recorded keys at all. */
    unknown?: boolean;
    /** Host IS known but the offered key does not match: the serious case. */
    mismatch?: boolean;
    fingerprint: string;
}
/** OpenSSH-style fingerprint: SHA256 base64, no padding. */
export declare function fingerprintOf(key: Buffer): string;
export declare function knownHostsPath(): string;
/** The name ssh uses in known_hosts: bare host on port 22, [host]:port otherwise. */
export declare function knownHostsName(host: string, port: number): string;
/**
 * Base64 key blobs recorded for this host, or [] when unknown.
 * Never throws: a missing known_hosts or absent ssh-keygen yields [].
 */
export declare function lookupKnownHostKeys(host: string, port: number): string[];
/** Compare the key offered by the server against known_hosts. */
export declare function checkHostKey(host: string, port: number, key: Buffer): HostKeyCheck;
export declare function unknownHostMessage(host: string, port: number, fingerprint: string): string;
export declare function mismatchMessage(host: string, port: number, fingerprint: string): string;
/** Append a newly accepted key, for hostKeyPolicy "accept-new". */
export declare function recordHostKey(host: string, port: number, key: Buffer, keyType: string): void;
