# opencode-sharedserver

An [OpenCode](https://opencode.ai) plugin that manages shared backend processes
through the [`sharedserver`](https://github.com/georgeharker/sharedserver) CLI.

When OpenCode starts, the plugin attaches to (or starts) each configured
server with `sharedserver use`. When OpenCode exits, it detaches with
`sharedserver unuse`. Because `sharedserver` is reference-counted, multiple
OpenCode instances — or other tools using the same name — share a single
backend process. The server survives editor restarts inside its grace period
and shuts down automatically when the last client leaves.

## Why

`sharedserver` is useful for long-lived development services that several
clients want to share: vector DBs, language servers behind a wrapper, model
inference servers, dev HTTP servers, and so on. This plugin wires those
services to OpenCode's lifecycle so they come up with the editor and tear
down cleanly when it exits, without you having to start them manually.

## Requirements

- OpenCode (with plugin support)
- The `sharedserver` binary on `PATH`, or referenced via the `binary` option
  or the `SHAREDSERVER_BIN` environment variable
  - Install: `cargo install sharedserver`, or see the
    [sharedserver README](https://github.com/georgeharker/sharedserver)

## Install

Add the plugin to your OpenCode config (`~/.config/opencode/config.json`).
OpenCode installs npm-published plugins automatically the first time it
encounters them in the `plugin` list.

```json
{
    "plugin": [
        ["@geohar/opencode-sharedserver@latest", {
            "servers": {
                "chroma": {
                    "command": "chroma",
                    "args": ["run", "--path", "/Users/me/.local/share/chromadb"],
                    "env": { "ANONYMIZED_TELEMETRY": "False" },
                    "gracePeriod": "30m"
                }
            }
        }]
    ]
}
```

The bare-string form (`"@geohar/opencode-sharedserver@latest"`) also
works for loading the plugin, but you'll need the tuple form shown above to
pass options.

## Configuration

Top-level options:

| Field     | Type                          | Description                                                              |
|-----------|-------------------------------|--------------------------------------------------------------------------|
| `binary`  | `string`                      | Path to the `sharedserver` executable. Overrides `SHAREDSERVER_BIN`/PATH lookup. |
| `lockdir` | `string`                      | Forwarded as `SHAREDSERVER_LOCKDIR` to child invocations.                |
| `servers` | `Record<string, ServerSpec>`  | Map of sharedserver name → server config.                                |

Per-server (`ServerSpec`):

| Field         | Type                       | Description                                                                              |
|---------------|----------------------------|------------------------------------------------------------------------------------------|
| `command`     | `string`                   | Binary to run as the shared server. Required unless `lazy` is true.                      |
| `args`        | `string[]`                 | Arguments passed to `command`.                                                           |
| `env`         | `Record<string, string>`   | Extra environment variables forwarded via `sharedserver --env KEY=VALUE`.                |
| `gracePeriod` | `string`                   | Duration string: `30s`, `5m`, `1h`, `2h30m`. Time the server stays alive with no clients.|
| `logFile`     | `string`                   | Capture server stdout/stderr to this path.                                               |
| `metadata`    | `string`                   | Optional metadata string forwarded to sharedserver.                                      |
| `lazy`        | `boolean`                  | Only attach if the server is already running; never start it.                            |

Binary resolution order:

1. `binary` option
2. `SHAREDSERVER_BIN` environment variable
3. `sharedserver` on `PATH`
4. `~/.cargo/bin/sharedserver`
5. `~/.local/bin/sharedserver`
6. `/usr/local/bin/sharedserver`
7. `/opt/homebrew/bin/sharedserver`

## What it runs

For each configured server, on plugin load:

```
sharedserver use <name> --pid <opencode-pid> \
    [--grace-period <gracePeriod>] \
    [--metadata <metadata>] \
    [--log-file <logFile>] \
    [--env K=V ...] \
    -- <command> [args ...]
```

The `--` and trailing command are omitted when `lazy: true`.

On `exit` / `SIGINT` / `SIGTERM` / `SIGHUP`:

```
sharedserver unuse <name> --pid <opencode-pid>
```

`unuse` runs synchronously so it completes from inside `exit` handlers. After
draining, signal handlers re-raise the original signal so OpenCode's exit
code is preserved.

## Behavior

- Missing binary, failed attach, or misconfigured entry: logged via OpenCode's
  app log (`service: "sharedserver"`); the plugin returns without throwing so
  OpenCode keeps running normally.
- `sharedserver` already has dead-client detection that polls every 5 s, so
  even if the plugin can't run its cleanup (hard crash, `kill -9`) the
  refcount eventually self-corrects.
- Multiple OpenCode instances pointing at the same `name` share one server.
  The first instance starts it; subsequent ones increment the refcount; the
  last one to exit triggers the grace period.

## Example: multiple servers

```json
{
    "plugin": [
        ["@geohar/opencode-sharedserver@latest", {
            "binary": "/opt/homebrew/bin/sharedserver",
            "servers": {
                "chroma": {
                    "command": "chroma",
                    "args": ["run", "--path", "/Users/me/.local/share/chromadb"],
                    "gracePeriod": "1h"
                },
                "ollama": {
                    "command": "ollama",
                    "args": ["serve"],
                    "env": { "OLLAMA_HOST": "127.0.0.1:11434" },
                    "gracePeriod": "2h",
                    "logFile": "/tmp/ollama.log"
                },
                "watchman": {
                    "lazy": true
                }
            }
        }]
    ]
}
```

## Local development

```bash
git clone https://github.com/georgeharker/opencode-sharedserver
cd opencode-sharedserver
npm install
npm run build         # emits dist/
npm run typecheck     # without emit
```

To test a local checkout against your OpenCode without publishing, point the
plugin spec at the directory:

```json
{
    "plugin": [
        ["file:///Users/me/Development/opencode-sharedserver", { "servers": { ... } }]
    ]
}
```

OpenCode reads `package.json`'s `main` field to find the compiled entry, so
run `npm run build` first.

## Diagnostics

Plugin events are written to OpenCode's structured log under the
`sharedserver` service. The usual location is:

```
${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log/
```

To inspect sharedserver itself:

```bash
sharedserver list
sharedserver info <name>
sharedserver admin doctor
```

## License

MIT
