# Close Reflect

Intercept Obsidian's quit and show a reflection prompt before the window closes — a chance
to look at where you are before you leave.

The prompt has an editable title, Markdown body, and as many action buttons as you want.
Buttons can cancel the quit, let the app close, open a note, run a command, or open a URL.

## How the interception works

Obsidian does not make this easy, and the interesting part of this plugin is the three
obstacles it works around. All three were established by reading Obsidian 1.13.7's own
bundle, and each one is verified by the plugin's own developer log.

**1. Obsidian's quit hook erases itself.** The workspace `quit` event is fired from inside
Obsidian's own `window.onbeforeunload` hook, and that hook starts by setting
`window.onbeforeunload = null` so the `window.close()` it re-issues cannot loop back into
it. One session therefore gets exactly one `quit` event. The plugin captures the hook before
its first run and puts it back after a quit it cancelled, which is what lets the second
close be intercepted too.

**2. Obsidian force-closes any window that survives a close for three seconds.** Its main
process arms `setTimeout(() => { !v.defaultPrevented && g.destroy() }, 3000)` on every
window close, and `destroy()` bypasses `beforeunload` entirely. The catch is that
`close.defaultPrevented` is only ever written by a *main-process* listener calling
`preventDefault()` — a renderer's `beforeunload` cancellation travels a different channel
(`will-prevent-unload`) and never marks it. Obsidian's own bootstrap hands the renderer the
window through `@electron/remote` (`window.electronWindow`), so the plugin joins that same
`close` event and marks it once it has decided to hold — which makes the timer stand down.
The mark has to happen *after* dispatch, not during it: preventing the close outright would
stop `beforeunload` from running at all, and the prompt would never appear.

**3. Holding the quit strands Obsidian's "Saving..." screen.** That screen lives on a
module-private singleton inside Obsidian's bundle and is only taken down by the very
`window.close()` the plugin swallows. There is no way to reach the instance, so the plugin
repeats what its `hide()` does — remove the container and drop the `in-progress` body class.

Every failure path fails open: an unanswered prompt follows the configured timeout action,
and a prompt that could not be shown at all releases the quit, so a broken overlay can never
leave the app unclosable.

## The edit modal

Settings keep the behavioural options. The title, the text and the buttons are edited in a
dedicated modal: editor on the left (a real Obsidian Markdown editor, with live preview and
`[[` completion), live preview on the right, Save and Cancel at the bottom. Everything is
edited on a draft, so Cancel really discards.

The modal adapts to the content source:

| | Inline text | Linked note |
| --- | --- | --- |
| Editor | the overlay text | the note's body, frontmatter excluded |
| Save | writes the text into the settings | writes the body back into the note, keeping its frontmatter |

In linked mode the note is only written when its body actually changed, and only if it was
readable in the first place — a note that could not be read is never written over.

The embedded editor borrows Obsidian's own CodeMirror through the module table Obsidian
exposes to plugins, so no second copy of CodeMirror is bundled and Obsidian's internal
editor state fields keep working. If that ever stops being available the modal falls back to
a plain textarea.

## Settings

| Setting | Meaning |
| --- | --- |
| Content source | Write the text inline, or render it from a note in the vault. |
| Title, text and buttons | Opens the edit modal. |
| Linked note | The note whose contents the overlay shows. Start typing to search. |
| Remembered copy | A copy of the linked note, used when the note cannot be read. |
| Interceptions before release | How many quits to interrupt. Once spent, later quits close without asking. |
| Release timeout | How long to wait for an answer. |
| When the timeout expires | Cancel the quit and stay open, or let the app close. Cancelling is the default. |
| Write diagnostics to a file | Appends one entry per quit attempt inside the vault. |
| Developer log | Echoes diagnostics to the console and writes a step-by-step trace to `close-reflect-trace.log` in the system temp folder. |

## Limitations

- The `quit` event is documented as *"Not guaranteed to actually run."* Crashes, an external
  `kill`, or a priority shutdown will skip the interception. This is best-effort.
- Registering a quit task breaks **Reload app without saving**: the reload command closes the
  window instead of reloading. Disable the plugin if you need that command.
- The interception relies on Obsidian internals (`@electron/remote`, the shape of its quit
  hook, and the progress-screen markup). A future Obsidian release could change any of them;
  each is guarded and falls back rather than breaking the app.

## Data and privacy

- **No network access. No telemetry. No analytics.**
- With *Write diagnostics to a file* on, the plugin appends one entry per quit attempt to a
  vault-relative path you choose.
- With *Developer log* on, it also writes a step-by-step trace to
  `close-reflect-trace.log` in the system temp folder. Both are off by default.

## Development

```sh
bun install
bun run build      # bundles src/main.ts -> main.js
bun run typecheck  # tsc --noEmit
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/close-reflect/` and enable the plugin.

## Credits

The embedded Markdown editor in `src/markdown-editor.ts` is ported from
[EmbeddableMarkdownEditor](https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838)
by Fevol, with the prototype-extraction technique originally from
[mgmeyers/obsidian-kanban](https://github.com/mgmeyers/obsidian-kanban) — both MIT licensed.
Only that MIT-licensed editor-construction code was carried over.

## License

MIT
