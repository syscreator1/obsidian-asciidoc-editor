# AsciiDoc Editor for Obsidian

Opinionated AsciiDoc editor for structured, technical documentation inside Obsidian.

> ⚠ Status: Experimental  
> 🎯 Audience: Developers / Technical Writers  
> 🧪 Stability: APIs and behaviors may change without notice

This project is intentionally opinionated.
For core design principles and non-negotiable decisions,
see [DESIGN.md](DESIGN.md).

---

## This plugin intentionally rejects Markdown compatibility

This plugin does NOT try to make AsciiDoc behave like Markdown.

It exists for users who:

- already chose AsciiDoc for a reason
- need explicit structure and composition
- work with large, multi-file documentation
- value correctness over convenience

If you expect Markdown-like behavior,
this plugin is not a good fit.

---

## Why this plugin exists

AsciiDoc is designed for serious documentation:
- specifications
- architecture documents
- long-lived technical manuals

Obsidian is an excellent knowledge platform,
but its core design assumes Markdown.

This plugin exists to bridge that gap
**without diluting AsciiDoc concepts**.

The goal is not to simplify AsciiDoc.
The goal is to **respect it**.

---

## What this plugin focuses on

- Structure over visual editing
- Explicit includes over implicit links
- Document composition over note fragments
- Preview as output, not as an editing crutch

This plugin treats documentation as **an engineered artifact**.

---

## Features

- AsciiDoc editing inside Obsidian
- Support for `include::[]` directives
- Diagram rendering via Kroki (PlantUML, Mermaid, etc.)
- Preview optimized for technical documents
- Designed for large documentation sets

Features are added only if they reinforce
clarity, structure, and scalability.

---

## Non-goals

This plugin intentionally does NOT provide:

- Markdown compatibility layers
- WYSIWYG editing
- Beginner documentation tutorials
- Full AsciiDoc toolchain replacement

If a feature hides AsciiDoc syntax or semantics,
it will not be implemented.

---

## Usage

1. Install the plugin
2. Open a `.adoc` file
3. Edit and preview AsciiDoc directly

Includes and diagrams are resolved during preview.
No implicit transformations are applied.

---

## Design Philosophy

- **AsciiDoc-first, always**
- **Explicit structure beats convenience**
- **Preview represents final output**
- **Designed for documentation that must scale**

This plugin embraces AsciiDoc complexity
instead of abstracting it away.

---

## Roadmap (subject to change)

- [ ] Include dependency analysis
- [ ] Cross-file navigation for includes
- [ ] Diagram caching and optimization
- [ ] Export support (PDF / HTML)
- [ ] External CLI-based processing engine

Future features must preserve
AsciiDoc semantics and transparency.

---

## Installation

This plugin is not yet published in the Obsidian Community Plugin list.

Manual installation:

1. Clone or download this repository
2. Place it under your Obsidian plugins directory
3. Enable the plugin in Obsidian settings

---

## License

Apache License 2.0

---

## Contributing

Issues and discussions are welcome.

Pull requests are welcome,
but design-driven changes should be discussed first.

This project prioritizes
consistency and long-term maintainability over popularity.

---

## Development

To deploy directly into your vault during development, copy `.env.example` to `.env` and set `OBSIDIAN_PLUGIN_DIR`.

---

## License

Licensed under the Apache License, Version 2.0.  
See the [LICENSE](./LICENSE) file for details.
