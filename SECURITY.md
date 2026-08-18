# Security

This repository is demonstration software.

The `canvas_agent_exec` tool runs agent-generated JavaScript inside BB's
browser page. That code receives the live editor and tldraw SDK. It can also
reach browser globals because the proof of concept does not use a sandbox.

Install the plugin only when you trust the agents and prompts using it. Do not
use it with untrusted users, models, or remote command sources.

The plugin's HTTP routes require the BB-generated plugin token. Do not publish
that token.
