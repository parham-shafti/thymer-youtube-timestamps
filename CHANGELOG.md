# Changelog

## v1.0.0 - 2026-09-24

First versioned release.

New:
- **Transcribe what was said.** `Cmd+Shift+U` starts a transcription, `Cmd+Shift+U` again ends it: the video's captions for that stretch land as a quote row at your caret, opening with the start and end times as clickable timestamps. Needs your own [Supadata](https://supadata.ai) API key, set from the clipboard with "YouTube: Set transcript API key from clipboard".
- A red recording marker in the status bar shows how long a transcription has run (click it to cancel), and a reminder every 5 minutes asks whether to keep going. Nothing ends on its own.
- **Player keys.** `Cmd+Shift+Space` plays or pauses. `Cmd+Shift+Left` / `Right` skip 10 seconds while the video plays, and leave those keys to the app when it is paused.

Fixed:
- A timestamp typed on a future day in the Journal lands on that day, not on today.
- A journal page is never created with a broken id (which stopped the Markdown Mirror from syncing).

Already there:
- `Cmd+Shift+T` starts a timestamped note row at the caret; click a timestamp to jump the player there, `Cmd+click` opens it on YouTube.
- "YouTube: Toggle pin video while scrolling" keeps the player in view.
