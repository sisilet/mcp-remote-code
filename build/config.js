import fs from "fs/promises";
import os from "os";
import path from "path";
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".mcp-remote-code", "targets.json");
/** Previous default; still checked as a fallback when the new path is missing. */
export const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".opencode", "mcp-remote-code-targets.json");
export function parseSshCommand(cmd) {
    const tokens = tokenizeCommand(cmd);
    if (tokens.length === 0 || tokens[0] !== "ssh") {
        throw new Error(`Remote Code: SSH command must start with "ssh", got: ${cmd}`);
    }
    let host = "";
    let user = "";
    let port = 22;
    let identity;
    const extraOptions = [];
    const applyOpenSshOption = (option) => {
        extraOptions.push(option);
        const { key, value } = parseOpenSshOption(option);
        switch (key.toLowerCase()) {
            case "port": {
                const parsed = parseInt(value, 10);
                if (isNaN(parsed))
                    throw new Error(`Remote Code: invalid Port option in SSH command`);
                port = parsed;
                break;
            }
            case "user":
                user = value;
                break;
            case "identityfile":
                identity = expandLocalPath(value);
                break;
        }
    };
    for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === "-p" || tok === "--port") {
            const value = nextValue(tokens, ++i, tok);
            port = parseInt(value, 10);
            if (isNaN(port))
                throw new Error(`Remote Code: invalid port in SSH command`);
        }
        else if (tok.startsWith("-p") && tok.length > 2) {
            port = parseInt(tok.slice(2), 10);
            if (isNaN(port))
                throw new Error(`Remote Code: invalid port in SSH command`);
        }
        else if (tok === "-i") {
            identity = expandLocalPath(nextValue(tokens, ++i, tok));
        }
        else if (tok.startsWith("-i") && tok.length > 2) {
            identity = expandLocalPath(tok.slice(2));
        }
        else if (tok.startsWith("-o")) {
            if (tok === "-o") {
                applyOpenSshOption(nextValue(tokens, ++i, tok));
            }
            else {
                applyOpenSshOption(tok.slice(2));
            }
        }
        else if (tok === "-l") {
            user = nextValue(tokens, ++i, tok);
        }
        else if (tok.startsWith("-l") && tok.length > 2) {
            user = tok.slice(2);
        }
        else if (tok.startsWith("-")) {
            if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
                i++;
            }
        }
        else if (tok.includes("@")) {
            const at = tok.lastIndexOf("@");
            user = tok.slice(0, at);
            host = tok.slice(at + 1);
        }
        else {
            host = tok;
        }
    }
    if (!host) {
        throw new Error(`Remote Code: could not parse host from SSH command: ${cmd}`);
    }
    // No default user (D-C). Defaulting to root meant a typo in the config
    // silently connected as root; defaulting to the local username is what ssh
    // does but is still implicit. A config file should say who it connects as.
    if (!user) {
        throw new Error(`Remote Code: no user in SSH command "${cmd}". ` +
            `Specify "user" on the target, or use user@host.`);
    }
    return { host, user, port, identity, extraOptions };
}
function parseOpenSshOption(option) {
    const eq = option.indexOf("=");
    if (eq === -1) {
        return { key: option.trim(), value: "" };
    }
    return {
        key: option.slice(0, eq).trim(),
        value: option.slice(eq + 1).trim(),
    };
}
function nextValue(tokens, index, option) {
    const value = tokens[index];
    if (!value) {
        throw new Error(`Remote Code: missing value for SSH option ${option}`);
    }
    return value;
}
function expandLocalPath(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return trimmed;
    if (trimmed === "~")
        return os.homedir();
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
    }
    // Absolute paths and identity paths: resolve when absolute-looking, else leave relative for SSH parsing callers that only expand ~
    if (path.isAbsolute(trimmed))
        return path.resolve(trimmed);
    return trimmed;
}
function tokenizeCommand(input) {
    const tokens = [];
    let current = "";
    let quote;
    const text = input.trim();
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\" && quote !== "'") {
            const next = text[i + 1];
            if (next && /[\s"'\\]/.test(next)) {
                current += next;
                i++;
                continue;
            }
            current += ch;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = undefined;
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === "'" || ch === `"`) {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += ch;
    }
    if (quote) {
        throw new Error(`Remote Code: unterminated quote in SSH command: ${input}`);
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}
export function buildRemoteConfig(sshCommand, remoteWorkdir, options) {
    // Structured fields win: they never went through shell tokenisation.
    const parsed = options?.connection
        ? {
            host: options.connection.host,
            user: options.connection.user,
            port: options.connection.port ?? 22,
            identity: options.connection.identity,
            extraOptions: sshCommand ? parseSshCommand(sshCommand).extraOptions : [],
        }
        : parseSshCommand(sshCommand);
    const mirrorRoot = options?.mirrorRoot ?? path.join(os.homedir(), ".mcp-remote-code", "mirrors");
    return {
        sshCommand,
        ...parsed,
        password: options?.password,
        passphrase: options?.passphrase,
        sudoPassword: options?.sudoPassword,
        remoteWorkdir,
        mirrorRoot,
        active: true,
        hostKeyPolicy: options?.hostKeyPolicy,
    };
}
export function buildLocalConfig(root, options) {
    const resolvedRoot = path.resolve(expandLocalPath(root));
    const mirrorRoot = options?.mirrorRoot ?? path.join(os.homedir(), ".mcp-remote-code", "mirrors");
    let user = "local";
    try {
        user = os.userInfo().username;
    }
    catch { }
    return {
        sshCommand: "local",
        host: "localhost",
        user,
        port: 0,
        extraOptions: [],
        remoteWorkdir: resolvedRoot,
        mirrorRoot,
        active: true,
    };
}
export function buildSshCommand(host, options) {
    const trimmed = host.trim().replace(/^ssh\s+/, "");
    const parts = ["ssh"];
    if (options?.identity) {
        parts.push("-i", expandLocalPath(options.identity));
    }
    if (options?.port && options.port !== 22) {
        parts.push("-p", String(options.port));
    }
    parts.push(trimmed);
    return parts.join(" ");
}
function withIdentity(sshCommand, identity) {
    const expanded = expandLocalPath(identity);
    const tokens = tokenizeCommand(sshCommand);
    if (tokens.length === 0 || tokens[0] !== "ssh") {
        return sshCommand;
    }
    for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === "-i" || tokens[i].startsWith("-i")) {
            return sshCommand;
        }
    }
    return `ssh -i ${expanded} ${tokens.slice(1).join(" ")}`;
}
function applyHostValue(pending, value) {
    const spec = parseRemoteSpec(value);
    if (spec.root) {
        pending.root = spec.root;
        pending.sshCommand = spec.sshCommand;
        pending.sshHost = "";
        return;
    }
    if (value.trim().startsWith("ssh ") || value.trim() === "ssh") {
        pending.sshCommand = spec.sshCommand;
        pending.sshHost = "";
        return;
    }
    pending.sshHost = value.trim();
    pending.sshCommand = "";
}
function finalizePendingConnection(pending) {
    let sshCommand = pending.sshCommand;
    if (!sshCommand) {
        sshCommand = pending.sshHost
            ? buildSshCommand(pending.sshHost, { identity: pending.identity })
            : "";
    }
    else if (pending.identity) {
        sshCommand = withIdentity(sshCommand, pending.identity);
    }
    return {
        name: pending.name,
        sshCommand,
        root: pending.root,
        ...(pending.password ? { password: pending.password } : {}),
        ...(pending.sudoPassword ? { sudoPassword: pending.sudoPassword } : {}),
    };
}
export function parseRemoteSpec(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return { sshCommand: "", root: "" };
    }
    const pathSep = trimmed.lastIndexOf(":/");
    if (pathSep !== -1) {
        const hostPart = trimmed.slice(0, pathSep).trim();
        const root = trimmed.slice(pathSep + 1);
        if (hostPart && root.startsWith("/")) {
            const sshCommand = hostPart.startsWith("ssh ") || hostPart === "ssh" ? hostPart : `ssh ${hostPart}`;
            return { sshCommand, root };
        }
    }
    const sshCommand = trimmed.startsWith("ssh ") || trimmed === "ssh"
        ? trimmed
        : trimmed.includes("@")
            ? `ssh ${trimmed}`
            : trimmed;
    return { sshCommand, root: "" };
}
function normalizeTargetEntry(raw, index) {
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `target${index + 1}`;
    const typeRaw = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
    const key = (typeof raw.key === "string" && raw.key) ||
        (typeof raw.identity === "string" && raw.identity) ||
        undefined;
    const port = typeof raw.port === "number"
        ? raw.port
        : typeof raw.port === "string" && raw.port.trim()
            ? Number.parseInt(raw.port, 10)
            : undefined;
    let sshCommand = (typeof raw.ssh === "string" && raw.ssh) ||
        (typeof raw.sshCommand === "string" && raw.sshCommand) ||
        "";
    const sshCommandWasProvided = Boolean(sshCommand);
    let root = (typeof raw.path === "string" && raw.path) ||
        (typeof raw.root === "string" && raw.root) ||
        (typeof raw.workdir === "string" && raw.workdir) ||
        "";
    const host = typeof raw.host === "string" ? raw.host : "";
    const user = typeof raw.user === "string" ? raw.user : "";
    const isLocal = typeRaw === "local" || (!typeRaw && !sshCommand && !host && !user && !!root);
    if (isLocal) {
        if (!root) {
            throw new Error(`Local target "${name}" requires path/root`);
        }
        const optional = raw.optional === true;
        return {
            name,
            type: "local",
            sshCommand: "",
            root: path.resolve(expandLocalPath(root)),
            ...(optional ? { optional: true } : {}),
        };
    }
    if (sshCommand) {
        const spec = parseRemoteSpec(sshCommand);
        sshCommand = spec.sshCommand;
        if (!root)
            root = spec.root;
    }
    else {
        if (host && !user && !host.includes("@")) {
            throw new Error(`Target "${name}": "user" is required (or use "host": "user@host"). ` +
                `There is no default user.`);
        }
        const sshHost = host.includes("@") ? host : user && host ? `${user}@${host}` : host;
        if (sshHost) {
            sshCommand = buildSshCommand(sshHost, {
                identity: key,
                port: Number.isFinite(port) ? port : undefined,
            });
        }
    }
    if (key && sshCommand && !sshCommand.includes("-i ")) {
        sshCommand = withIdentity(sshCommand, key);
    }
    if (Number.isFinite(port) && port && port !== 22 && sshCommand && !/\s-p(\s+\d+|\d+)/.test(sshCommand)) {
        const tokens = tokenizeCommand(sshCommand);
        if (tokens[0] === "ssh") {
            sshCommand = `ssh -p ${port} ${tokens.slice(1).join(" ")}`;
        }
    }
    const password = typeof raw.password === "string" ? raw.password : undefined;
    const passphrase = typeof raw.passphrase === "string" ? raw.passphrase : undefined;
    const sudoPassword = (typeof raw.sudoPassword === "string" && raw.sudoPassword) ||
        (typeof raw.sudo_password === "string" && raw.sudo_password) ||
        undefined;
    const optional = raw.optional === true;
    const elicitRaw = typeof raw.elicitation === "string" ? raw.elicitation.trim().toLowerCase() : "";
    const elicitation = elicitRaw === "on" || elicitRaw === "off" ? elicitRaw : undefined;
    if (elicitRaw && !elicitation) {
        throw new Error(`Target "${name}": elicitation must be "on" or "off"`);
    }
    const policyRaw = typeof raw.hostKeyPolicy === "string" ? raw.hostKeyPolicy.trim().toLowerCase() : "";
    const hostKeyPolicy = policyRaw === "verify" || policyRaw === "accept-new" || policyRaw === "insecure"
        ? policyRaw
        : undefined;
    if (policyRaw && !hostKeyPolicy) {
        throw new Error(`Target "${name}": hostKeyPolicy must be "verify", "accept-new" or "insecure"`);
    }
    // Structured entries carry their fields verbatim; the ssh string remains
    // only for display and for entries written in `ssh ...` form.
    const structured = host && !sshCommandWasProvided
        ? {
            connection: {
                host: host.includes("@") ? host.slice(host.lastIndexOf("@") + 1) : host,
                user: host.includes("@") ? host.slice(0, host.lastIndexOf("@")) : user,
                ...(Number.isFinite(port) && port ? { port } : {}),
                ...(key ? { identity: expandLocalPath(key) } : {}),
            },
        }
        : {};
    return {
        name,
        type: "ssh",
        sshCommand,
        root,
        ...structured,
        password,
        passphrase,
        sudoPassword,
        ...(optional ? { optional: true } : {}),
        ...(hostKeyPolicy ? { hostKeyPolicy } : {}),
        ...(elicitation ? { elicitation } : {}),
    };
}
export async function loadTargetsConfigFile(configPath) {
    const data = (await fs.readFile(configPath, "utf-8")).replace(/^\uFEFF/, "");
    const connections = parseTargetsJson(JSON.parse(data), `Config file ${configPath}`);
    // A relative local root in the config means "relative to the config file",
    // not to the MCP process's cwd, which under a desktop client is arbitrary
    // (review F-20).
    const configDir = path.dirname(path.resolve(configPath));
    for (const c of connections) {
        if (c.type === "local" && c.root && !path.isAbsolute(c.root)) {
            c.root = path.resolve(configDir, c.root);
        }
    }
    await warnIfConfigWorldReadable(configPath, data);
    return connections;
}
/**
 * Warn on stderr when a config that contains plaintext secrets is readable
 * by group or others (review F-11). Mirrors ssh's insistence on 0600 keys.
 * Warn rather than refuse, to avoid breaking an existing setup on upgrade.
 */
async function warnIfConfigWorldReadable(configPath, rawData) {
    const hasSecret = /"(password|sudoPassword|sudo_password)"\s*:/.test(rawData);
    if (!hasSecret)
        return;
    try {
        const st = await fs.stat(configPath);
        const perms = st.mode & 0o077; // group + other bits
        if (perms !== 0) {
            const octal = (st.mode & 0o777).toString(8);
            console.error(`[mcp-remote-code] WARNING: ${configPath} is mode ${octal} and contains plaintext ` +
                `secrets. Restrict it: chmod 600 ${configPath}`);
        }
    }
    catch {
        // stat failure is non-fatal; the read already succeeded.
    }
}
export function parseTargetsJson(parsed, label = "Targets config") {
    const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.targets)
            ? parsed.targets
            : null;
    if (!entries) {
        throw new Error(`${label} must contain a targets array`);
    }
    return entries.map((entry, index) => normalizeTargetEntry(entry, index));
}
export function loadTargetsFromEnv() {
    const raw = process.env.MCP_REMOTE_CODE_TARGETS?.trim();
    if (!raw)
        return null;
    return parseTargetsJson(JSON.parse(raw), "MCP_REMOTE_CODE_TARGETS");
}
export function parseStartupConnections(argv = process.argv.slice(2)) {
    const connections = [];
    const configPaths = [];
    let current = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") {
            continue;
        }
        if (arg === "--config" || arg === "-c") {
            configPaths.push(argv[++i]);
            continue;
        }
        if (arg === "--remote" || arg === "--connect" || arg === "--ssh") {
            if (current)
                connections.push(finalizePendingConnection(current));
            current = {
                name: `target${connections.length + 1}`,
                sshHost: "",
                sshCommand: "",
                root: "",
            };
            applyHostValue(current, argv[++i]);
            continue;
        }
        if (!current)
            continue;
        if (arg === "--key" || arg === "-i" || arg === "--identity") {
            current.identity = argv[++i];
        }
        else if (arg === "--path" || arg === "--root" || arg === "--workdir" || arg === "-w") {
            current.root = argv[++i];
        }
        else if (arg === "--name" || arg === "-n") {
            current.name = argv[++i];
        }
        else if (arg === "--password") {
            current.password = argv[++i];
        }
        else if (arg === "--sudo-password") {
            current.sudoPassword = argv[++i];
        }
    }
    if (current)
        connections.push(finalizePendingConnection(current));
    if (connections.length === 0 && configPaths.length === 0 && process.env.REMOTE_SSH) {
        const spec = parseRemoteSpec(process.env.REMOTE_SSH);
        connections.push(finalizePendingConnection({
            name: process.env.REMOTE_NAME || "default",
            sshHost: "",
            sshCommand: spec.sshCommand,
            identity: process.env.REMOTE_KEY || process.env.REMOTE_IDENTITY,
            root: process.env.REMOTE_ROOT ||
                process.env.REMOTE_WORKDIR ||
                process.env.REMOTE_PATH ||
                spec.root ||
                "",
            password: process.env.REMOTE_PASSWORD,
            sudoPassword: process.env.REMOTE_SUDO_PASSWORD,
        }));
    }
    return { connections, configPaths };
}
export async function resolveStartupConnections(argv = process.argv.slice(2)) {
    const { connections, configPaths } = parseStartupConnections(argv);
    const resolved = [...connections];
    if (configPaths.length > 0) {
        for (const configPath of configPaths) {
            resolved.push(...(await loadTargetsConfigFile(configPath)));
        }
        return validateStartupConnections(resolved);
    }
    if (resolved.length > 0) {
        return validateStartupConnections(resolved);
    }
    const fromEnv = loadTargetsFromEnv();
    if (fromEnv) {
        return validateStartupConnections(fromEnv);
    }
    try {
        resolved.push(...(await loadTargetsConfigFile(DEFAULT_CONFIG_PATH)));
        return validateStartupConnections(resolved);
    }
    catch (err) {
        const code = err.code;
        if (code !== "ENOENT")
            throw err;
    }
    try {
        resolved.push(...(await loadTargetsConfigFile(LEGACY_CONFIG_PATH)));
        return validateStartupConnections(resolved);
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            throw new Error(`No startup targets found. Pass --config ${DEFAULT_CONFIG_PATH}, set MCP_REMOTE_CODE_TARGETS, or use --ssh/--key/--path`);
        }
        throw err;
    }
}
export function validateStartupConnections(connections) {
    if (connections.length === 0) {
        throw new Error("At least one remote target is required.");
    }
    const names = new Set();
    for (const connection of connections) {
        if (connection.type !== "local" && !connection.sshCommand) {
            throw new Error(`Target "${connection.name}" is missing an SSH command.`);
        }
        if (!connection.root) {
            throw new Error(`Target "${connection.name}" is missing a root directory.`);
        }
        if (names.has(connection.name)) {
            throw new Error(`Duplicate target name "${connection.name}".`);
        }
        names.add(connection.name);
    }
    return connections;
}
export function parseStartupConnection(argv = process.argv.slice(2)) {
    const { connections } = parseStartupConnections(argv);
    return connections[0] ?? null;
}
export function validateStartupConnection(connection) {
    if (!connection) {
        throw new Error("Missing startup connection. Provide --ssh and --path (or REMOTE_SSH and REMOTE_ROOT).");
    }
    if (!connection.sshCommand) {
        throw new Error("Missing SSH command. Provide --ssh or REMOTE_SSH.");
    }
    if (!connection.root) {
        throw new Error("Missing remote root. Provide --path (or --root / REMOTE_ROOT / REMOTE_PATH).");
    }
    return connection;
}
//# sourceMappingURL=config.js.map