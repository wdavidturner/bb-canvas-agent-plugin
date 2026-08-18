# Canvas Agent for BB

Canvas Agent adds a persistent canvas beside each [BB](https://getbb.app/)
thread. Agents can inspect and change the open canvas through native tools.

This repository is demonstration software. It favors a small, inspectable
implementation over production isolation and complete file compatibility.

## Features

- One persisted canvas for each BB thread.
- A separate Studio canvas in BB navigation.
- Saved shapes, pages, camera position, zoom, and selection.
- Native agent tools for inspection and JavaScript execution.
- A `bb canvas` command and token-authenticated HTTP bridge.
- A configurable client-side tldraw license key.

## Requirements

- BB 0.38.0 or newer.
- BB plugin SDK 0.4.6 or newer.
- npm available for BB's Git installation build.
- An applicable tldraw license for production use.

## Install from GitHub

Run this command:

```text
bb plugin install git:https://github.com/wdavidturner/bb-canvas-agent-plugin.git@v0.1.0
```

Restart BB if it does not load the plugin automatically.

## Configure the tldraw license

1. Open **Extensions** in BB.
2. Select **Canvas Agent**.
3. Enter the key under **tldraw license key**.
4. Reload the plugin or refresh the canvas.

The key is public client-side configuration. BB sends it to the browser.

## Use the canvas

1. Open a BB thread.
2. Open **Canvas Agent** from the thread panel launcher.
3. Ask the agent to draw, inspect, arrange, or edit the canvas.

Commands wait in SQLite when the canvas is closed. The open canvas executes
them and saves its snapshot.

## Agent and command interfaces

The plugin registers these native tools:

```text
canvas_agent_inspect
canvas_agent_exec
```

It also registers these commands:

```text
bb canvas status
bb canvas inspect
bb canvas exec "return editor.getCurrentPageShapes()"
bb canvas clear
```

Pass `--thread <thread-id>` outside a BB thread. Pass `--canvas studio` for the
navigation canvas.

## Trust boundary

`canvas_agent_exec` runs agent-generated JavaScript in BB's browser page. The
code is not sandboxed. It can affect shared page state outside its canvas.

Use this plugin only with trusted agents and prompts. Read
[`SECURITY.md`](SECURITY.md) before installation.

## Current limits

- No `.tldraw` archive import or export.
- No durable document scripts.
- No embedded asset storage.
- No collaboration or sync server.
- No operating-system file associations.
- No sandbox for arbitrary JavaScript.

## Develop locally

1. Install dependencies.

   ```text
   npm install
   ```

2. Install the local plugin.

   ```text
   bb plugin install .
   ```

3. Start the plugin development loop.

   ```text
   bb plugin dev
   ```

4. Run all checks before a release.

   ```text
   npm run check
   ```

## Licensing

The plugin code is available under the MIT license.

The bundled tldraw SDK remains under the separate tldraw license. Downstream
users need their own applicable license for production use. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

This project is independent. It is not affiliated with or endorsed by BB or
tldraw.
