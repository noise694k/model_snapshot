# Model Snapshot

A SillyTavern extension for recording what each proxy/model combination is actually like — right when you notice it, mid-chat.

## Usage

Wand menu → **📸 지금 SHOT** captures your current setup. Add labels, write a note, done.

**A card = provider + model + post-processing + preset name.** Same four values, same card. Any difference creates a new card. Parameters (temperature, etc.) are recorded but don't affect grouping.

New providers and models prompt you for a short alias. Aliases are display-only — renaming later never splits or merges existing records.

## Features

- **Labels** — censorship / reasoning / quality (👍👎) / anomalies / technical issues / speed, plus your own
- **Search & filter** — across aliases, model strings, notes, character names, labels. Stackable
- **Jump to message** — return to the exact message you snapshotted. Warns if it changed
- **Compare** — diff two snapshots side by side
- **Provider management** — pricing page links, status (ok / unstable / dead), endpoint grouping
- **Export** — JSON (backup & restore), Markdown (for writing things up)

## Storage

Uses browser **IndexedDB** only. Never touches `settings.json`. Reads SillyTavern data, never writes to it.

⚠️ **Clearing browser data deletes your records.** Export JSON periodically from the Settings tab. Reminds you every 7 days by default.

API keys and proxy passwords are never captured. Endpoint URLs are stored and included in exports — be careful when sharing.

## Troubleshooting

Settings tab → Diagnostics:
- **현재 캡처 테스트** — shows which fields failed to read
- **화면 배치 진단** — for broken layout
- **로그 보기** — error log