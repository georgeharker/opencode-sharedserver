// OpenCode plugin: manage shared backend processes via the `sharedserver` CLI.
// See README.md for installation and configuration.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

type ServerSpec = {
    /** Binary to run (required unless `lazy` is true). */
    command?: string
    /** Arguments passed to `command`. */
    args?: string[]
    /** Extra environment variables forwarded via `--env KEY=VALUE`. */
    env?: Record<string, string>
    /** Grace period for sharedserver, e.g. "30m", "1h", "2h30m". */
    gracePeriod?: string
    /** Capture stdout/stderr of the managed server to this path. */
    logFile?: string
    /** Optional metadata string forwarded to sharedserver. */
    metadata?: string
    /** Only attach if the server is already running; never start it. */
    lazy?: boolean
}

type Options = {
    /** Explicit path to the `sharedserver` binary. */
    binary?: string
    /** Override SHAREDSERVER_LOCKDIR for child invocations. */
    lockdir?: string
    /** Map of sharedserver name -> server config. */
    servers?: Record<string, ServerSpec>
}

type LogFn = (level: "info" | "warn" | "error", message: string) => void

const CANDIDATE_BINARIES = [
    "sharedserver",
    join(homedir(), ".cargo", "bin", "sharedserver"),
    join(homedir(), ".local", "bin", "sharedserver"),
    "/usr/local/bin/sharedserver",
    "/opt/homebrew/bin/sharedserver",
]

function resolveBinary(override: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
    const envBin = env.SHAREDSERVER_BIN
    const candidates = [override, envBin, ...CANDIDATE_BINARIES].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
    )
    for (const candidate of candidates) {
        // Absolute / relative paths: check the file exists.
        if (candidate.includes("/")) {
            if (existsSync(candidate)) return candidate
            continue
        }
        // Bare command: probe via the CLI to confirm it's on PATH.
        const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", env })
        if (probe.status === 0) return candidate
    }
    return undefined
}

function buildUseArgs(name: string, spec: ServerSpec, pid: number): string[] {
    const args = ["use", name, "--pid", String(pid)]
    if (spec.gracePeriod) args.push("--grace-period", spec.gracePeriod)
    if (spec.metadata) args.push("--metadata", spec.metadata)
    if (spec.logFile) args.push("--log-file", spec.logFile)
    for (const [k, v] of Object.entries(spec.env ?? {})) {
        args.push("--env", `${k}=${v}`)
    }
    if (!spec.lazy && spec.command) {
        args.push("--", spec.command, ...(spec.args ?? []))
    }
    return args
}

type Attached = { binary: string; name: string; env: NodeJS.ProcessEnv }

const attached: Attached[] = []
let cleanupInstalled = false

function installCleanup() {
    if (cleanupInstalled) return
    cleanupInstalled = true

    const drain = () => {
        while (attached.length) {
            const s = attached.pop()!
            // Synchronous spawn so this works from `exit` handlers too.
            spawnSync(s.binary, ["unuse", s.name, "--pid", String(process.pid)], {
                stdio: "ignore",
                env: s.env,
            })
        }
    }

    process.on("exit", drain)

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
    for (const sig of signals) {
        process.on(sig, () => {
            drain()
            // Re-raise so the original signal semantics apply (e.g. exit code).
            process.kill(process.pid, sig)
        })
    }
}

const SharedServerPlugin: Plugin = async ({ client }, options) => {
    const opts = (options ?? {}) as Options
    const servers = opts.servers ?? {}

    const log: LogFn = (level, message) => {
        client.app
            .log({ body: { service: "sharedserver", level, message } })
            .catch(() => {})
    }

    if (Object.keys(servers).length === 0) {
        log("warn", "no servers configured; plugin is inert")
        return {}
    }

    const env: NodeJS.ProcessEnv = { ...process.env }
    if (opts.lockdir) env.SHAREDSERVER_LOCKDIR = opts.lockdir

    const binary = resolveBinary(opts.binary, env)
    if (!binary) {
        log("error", "sharedserver binary not found; set `binary` option or install it on PATH")
        return {}
    }

    installCleanup()

    for (const [name, spec] of Object.entries(servers)) {
        if (!spec.command && !spec.lazy) {
            log("error", `server "${name}" has no command and is not lazy; skipping`)
            continue
        }

        const args = buildUseArgs(name, spec, process.pid)
        const result = spawnSync(binary, args, { stdio: "pipe", env })

        if (result.error) {
            log("error", `sharedserver use ${name} failed to spawn: ${result.error.message}`)
            continue
        }
        if (result.status !== 0) {
            const stderr = result.stderr?.toString().trim()
            log(
                "error",
                `sharedserver use ${name} exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
            )
            continue
        }

        attached.push({ binary, name, env })
        log("info", `attached to sharedserver "${name}"`)
    }

    return {}
}

export default SharedServerPlugin
