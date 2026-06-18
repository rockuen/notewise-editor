# NoteWise Markdown Editor

No more Obsidian switching.

NoteWise Markdown Editor combines a calendar sidebar with a polished Markdown live editor for VS Code and VSCodium.

## Features

- Calendar sidebar with date-based note navigation from DateWise.
- Custom live editor for `.md` and `.markdown` files.
- Markdown preview behavior for tables, images, links, headings, lists, and blockquotes while staying editable.
- External `http`, `https`, `mailto`, and `tel` links open through the OS default browser/app.
- Inline code keeps the same font size as surrounding text for readability.
- Obsidian-style wiki links with `[[` note suggestions, clickable highlighted `[[Note]]` text, and missing-note creation.
- Pasted images are saved to an `assets` folder and inserted as Markdown image links.
- Explorer context menu, editor tab menu, and `Ctrl+Shift+Alt+M` / `Cmd+Shift+Alt+M` open shortcut.
- Custom CSS injection for editor layout and Markdown styling tweaks.
- Black and white editor palettes with automatic VS Code theme detection.
- Editor font selection from installed system fonts.
- Markdown syntax visibility, typography, and indentation settings.
- NoteWise product icon and optional Markdown file icon theme.

## Commands

- `NoteWise: Open with NoteWise Markdown Editor`
- `NoteWise: Switch NoteWise Markdown Editor`
- `NoteWise: Select Editor Font`
- `NoteWise: Focus Calendar`
- `NoteWise: Install Google Calendar Connector`

The default editor switch keybinding is `Ctrl+K Y` or `Cmd+K Y`.
The default open keybinding is `Ctrl+Shift+Alt+M` or `Cmd+Shift+Alt+M`.
The default calendar focus keybinding is `Ctrl+Shift+B` or `Cmd+Shift+B`.

## File Icon Theme

To use the NoteWise image for Markdown files, run `Preferences: File Icon Theme` and select `NoteWise Markdown File Icons`.

## Settings

NoteWise keeps the existing setting keys for compatibility:

```json
{
  "noteWise.calendar.openMarkdownIn": "editor",
  "noteWise.editor.theme.mode": "auto",
  "noteWise.editor.ui.fontFamily": "",
  "noteWise.editor.imageSaveFolder": "assets",
  "noteWise.editor.customCss": "",
  "noteWise.editor.indentation.listStep": 18,
  "noteWise.editor.indentation.blockquoteStep": 14,
  "noteWise.editor.livePreview.syntaxVisibility": "auto"
}
```

## Development

Active development/build work should happen outside the Obsidian vault:

```powershell
cd "C:\Users\FURSYS\OneDrive\Developed Apps\notewise-editor"
```

```powershell
npm install
npm run typecheck
npm run build
npm run package
```

## GitHub Automation

Repository: https://github.com/rockuen/notewise-editor

Pushes to `main` run the `Publish Open VSX` GitHub Actions workflow:

1. `npm ci`
2. `npm run typecheck`
3. `npm audit --omit=dev`
4. `npm run package`
5. Publish the generated VSIX to Open VSX with the `OVSX_PAT` repository secret

Duplicate versions are skipped, so pushing documentation-only changes does not fail the workflow.

## Publishing

Open VSX identity:

- Publisher: `rockuen`
- Extension ID: `rockuen.notewise-editor`
- Published version: `0.1.22`
- Current package: `notewise-editor-0.1.22.vsix`
- Listing: https://open-vsx.org/extension/rockuen/notewise-editor

Publish with an Open VSX token stored in `OVSX_PAT`:

```powershell
$env:OVSX_PAT = "<token>"
npx ovsx verify-pat rockuen -p $env:OVSX_PAT
npx ovsx publish ".\notewise-editor-0.1.22.vsix" -p $env:OVSX_PAT
```

The token can also be stored with `npx ovsx login rockuen` or provided by a CI secret named `OVSX_PAT`.

Publish history:

- 2026-06-17: Published `rockuen.notewise-editor` v0.1.20 to Open VSX.
- Verified after publish with `npx ovsx get rockuen.notewise-editor --metadata`.
- The one-time token used for the publish was not written to project files. Rotate/revoke that token after use if it was shared in chat.
- 2026-06-18: Prepared v0.1.21 to open external web/app hyperlinks via `vscode.env.openExternal` while keeping Markdown file links inside NoteWise.
- 2026-06-18: Published v0.1.22 to Open VSX and connected GitHub push-to-main automation through GitHub Actions.
