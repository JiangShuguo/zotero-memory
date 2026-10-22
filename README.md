# Zotero Memory

[Zotero](https://www.zotero.org/) plugin for reading and writing annotation notes next to the PDF page. Changes sync back into Zotero’s annotation comments.

[Chinese](README.zh-CN.md)

| | |
| --- | --- |
| Version | 1.3.0 |
| Author | jsg |
| Compatible with | Zotero 7.x – 10.* |
| License | MIT |

---

## Why it exists

Annotation notes in Zotero usually live in the reader sidebar. Memory puts those notes beside the page you are reading, so you can review and revise them without constantly switching focus.

---

## Behavior

### Margin cards

For each visible annotation that has a comment (or a note / a temporarily pinned annotation), Memory draws a card in the left or right margin and connects it to the mark with a short leader line.

| | |
| --- | --- |
| Card border | Uses the annotation color on all four sides |
| Placement | Near the annotation; left or right according to where the mark sits on the page |
| Overflow | When a column is full, scroll the column to see the rest |
| Low zoom | Below 80% zoom, non-editing cards collapse to a single line |

### Reading and editing

| | |
| --- | --- |
| Short comments | The card grows with the text |
| Long comments | Height caps at about nine lines; scroll inside the card |
| Scrollbar | Thin bar in the annotation color; dim when idle, bright while scrolling |
| Click | Opens in-place editing |
| Color button | In the edit toolbar; changes the annotation color |
| Drag | Selects text to copy (Ctrl/Cmd+C) |
| Autosave | About 700 ms after you stop typing |
| Save now | Ctrl/Cmd+Enter |
| Cancel | Esc restores the last saved text |
| Format toolbar | Shown only while that card is being edited |

Supported formatting: bold, italic, underline, strikethrough, superscript, subscript, font sizes 11 / 13 / 15 / 18, bulleted list, and clear formatting.

Shortcut keys while editing: Ctrl/Cmd+B / I / U for bold, italic, and underline; Ctrl/Cmd+A selects the whole comment. In the preview, Ctrl/Cmd+A selects the card text and Ctrl/Cmd+C copies the selection.

### Reader integration

| | |
| --- | --- |
| Toolbar button | Show or hide all margin cards |
| Context menu | Show selected annotations as margin cards |
| Hover | Hovering a card highlights the matching annotation on the page |
| Selection | Selecting an annotation highlights its card |
| Native popup | Used to write a new comment; hidden once a margin card is shown |
| Preferences | Choose which annotation types appear; shows the installed version, checks for updates, and lists the changelog |
| Export / import | Item menu backs up one PDF; Preferences open a dialog to pick PDFs by collection (export) or multiple JSON backups matched by filename / item title (import). Same-file restores are direct; different files are matched by text, and unplaced annotations are listed before writing |

Comments are stored in Zotero’s annotation comment field.

---

## Install

1. Download `memory.xpi` from [Releases](https://github.com/JiangShuguo/zotero-memory/releases), or build:

```text
cd memory
npm install
npm run build
```

Requires Node.js 18+ and Python 3.8+. Output: `memory/build/memory.xpi`.

2. Zotero → Tools → Plugins → gear → **Install Plugin From File…** → select `memory.xpi`.
3. Enable **Memory**, then restart Zotero.

After an upgrade, restart Zotero once.

---

## Develop

```text
cd memory
npm install
npm run typecheck
npm run build
```

---

## Repository layout

```text
memory/
  addon/           bootstrap, manifest, prefs, preferences UI, icons
  src/             TypeScript plugin source (bundled into the XPI)
  tools/           build_xpi.py
  updates.json     Zotero update manifest
  build/           memory.xpi (gitignored)
```

---

## License

MIT
