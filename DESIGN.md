# Design Philosophy

This document describes the core design principles shared across
the SQL Workbench and AsciiDoc Editor projects.

These principles are intentional and non-negotiable.
Features and changes are evaluated against them.

---

## 1. Target Audience

These tools are built for:

- developers
- engineers
- technical writers
- maintainers of long-lived assets

They are NOT designed for:

- beginners
- casual note-taking
- quick experiments
- tutorial-style workflows

Ease of onboarding is explicitly deprioritized
in favor of long-term correctness and maintainability.

---

## 2. Opinionated by Design

These projects are intentionally opinionated.

They do not attempt to:

- satisfy all use cases
- emulate existing tools
- hide underlying complexity

Instead, they make explicit choices
about what is supported and what is not.

Opinionated design is treated as a feature,
not a limitation.

---

## 3. Explicitness Over Convenience

Implicit behavior is avoided whenever possible.

Preferred patterns include:

- explicit configuration
- visible structure
- inspectable outputs

Hidden transformations, magic defaults,
and silent corrections are considered harmful.

Users should always be able to answer:

> “What is this tool doing, and why?”

---

## 4. Static Analysis Over Execution

Both projects prioritize **static analysis**.

They focus on:

- structure
- dependencies
- relationships
- risk indicators

They intentionally avoid:

- executing SQL
- modifying external systems
- performing side effects

Understanding comes before action.

---

## 5. Separation of Concerns

Responsibilities are clearly separated:

- Obsidian plugins handle UI, navigation, and visualization
- External tools (CLI) handle heavy analysis and processing

This separation enables:

- simpler plugin code
- easier testing
- CI/CD integration
- fork-based customization

Monolithic designs are explicitly avoided.

---

## 6. Designed for Forking

These projects assume they may be forked.

Forking is not treated as a failure,
but as a valid and expected outcome.

Design decisions therefore favor:

- readable code
- clear boundaries
- minimal hidden coupling
- stable core concepts

Upstream and downstream divergence
is considered a normal lifecycle.

---

## 7. Long-Term Assets, Not Disposable Files

SQL queries and technical documents
are treated as **long-lived assets**.

Design assumptions include:

- multiple authors over time
- schema or structure changes
- partial knowledge by maintainers
- operational risk

Short-term productivity gains
must not compromise long-term safety.

---

## 8. Machine-Readable First

Where possible, outputs should be:

- structured
- machine-readable
- reusable

Human-readable views are layered on top
of structured representations.

This enables:

- automation
- CI/CD usage
- external tooling
- alternative visualizations

---

## 9. Stability Through Restraint

Features are added slowly and deliberately.

A feature will be rejected if it:

- obscures underlying behavior
- introduces implicit state
- conflicts with core principles
- exists mainly for convenience

The goal is not rapid growth,
but sustained reliability.

---

## 10. Contribution Expectations

Contributions are welcome.

However, contributors are expected to:

- understand this document
- respect the design principles
- prioritize clarity over cleverness

Changes that conflict with these principles
are unlikely to be accepted,
regardless of implementation quality.

---

## Closing Note

These tools are not designed to be popular.
They are designed to be trusted.

Clarity, explicitness, and long-term thinking
are valued over ease, speed, and surface-level usability.
