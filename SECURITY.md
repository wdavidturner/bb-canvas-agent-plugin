# Security

This repository is demonstration software.

The `canvas_agent_exec` tool runs agent-generated JavaScript inside BB's
browser page. That code receives the live editor and tldraw SDK.

The runtime shadows common browser globals by default. This reduces accidental
changes to BB's shared interface. It is not a security sandbox. Determined code
can recover browser access, and users can explicitly enable browser globals in
the plugin settings.

Install the plugin only when you trust the agents and prompts using it. Do not
use it with untrusted users, models, or remote command sources.

The plugin's HTTP routes require the BB-generated plugin token. Do not publish
that token.
