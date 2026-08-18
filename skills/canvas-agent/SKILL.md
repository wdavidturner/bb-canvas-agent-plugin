---
name: canvas-agent
description: Inspect and edit the live tldraw canvas associated with the current BB thread.
---

# Canvas Agent

Use the native `canvas_agent_inspect` and `canvas_agent_exec` tools to
work with the canvas beside this BB chat.

## Workflow

1. Inspect before you change existing canvas content.
2. Use stable shape IDs for content you might update later.
3. Make the smallest complete change.
4. Return a compact verification value from each exec.
5. Include `::canvas-agent{}` in your reply after a successful change.

If a tool says the command is queued, ask the user to open Canvas Agent for
the current thread. Do not submit the same command again. The panel runs queued
commands automatically when it opens.

## Exec environment

The exec code is an async function body with these variables:

- `editor`: the live tldraw `Editor`
- `tldraw`: the full tldraw SDK module

Create a labelled rectangle:

```js
const id = tldraw.createShapeId("concept-card");
editor.createShape({
  id,
  type: "geo",
  x: 120,
  y: 100,
  props: {
    geo: "rectangle",
    w: 280,
    h: 160,
    richText: tldraw.toRichText("Concept"),
  },
});
return { created: id };
```

Update a known shape:

```js
const id = tldraw.createShapeId("concept-card");
editor.updateShape({ id, type: "geo", x: 200, y: 140 });
return editor.getShape(id);
```

Delete all shapes on the current page:

```js
editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
return { cleared: true };
```

Use the CLI only when the native tools are unavailable:

```text
bb canvas inspect
bb canvas exec "return editor.getCurrentPageShapes()"
bb canvas clear
bb canvas inspect --canvas studio
```
