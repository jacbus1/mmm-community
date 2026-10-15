# Design: The Community Workbench

## Intent

A small team's calm, legible workspace for turning a brief into reviewed work.
Preserve MMM's project/conversation/task structure. Never invent usage metrics,
agent activity or provider capabilities for a prettier dashboard.

## Visual system

| Token | Value | Purpose |
| --- | --- | --- |
| Canvas | `#f7f6ee` | Warm paper, subtle botanical gradient |
| Ink | `#233a35` | Reading and headings |
| Action | `#236657` | Primary controls |
| Accent | `#a35732` | Numbered workflow detail |
| Tint | `#e4eee6` | Selection |
| Border | `#dcded4` | Structural separation |
| Display | Georgia / Noto Serif TC / serif | Editorial headline |
| Interface | Trebuchet MS / Noto Sans TC / sans-serif | Readable controls |

Fonts are local fallbacks, never fetched externally. Original MMM logo bytes
are retained. README screenshots show this Community edition with disposable,
synthetic local data; they contain no private artwork or account data.

The welcome view places an editorial introduction beside a Design / Build /
Review worksheet. This is a process illustration, not a simulated active team.
At narrow widths it stacks vertically. Short entrance motion respects
`prefers-reduced-motion`. There is no continuously animated dashboard.

## Interaction and accessibility

- Notes, local tasks and AI tasks remain distinct.
- Team presets create a draft after confirmation. They never run automatically;
  provider fields start empty.
- Sharing and costs are disclosed before submission.
- AI outputs await human review, never automatic approval.
- The composer stays in document flow, not a fixed overlay.
- Native-only features explain unavailability.
- Preserve dialog focus, labelled controls, keyboard tabs, status announcements
  and visible focus rings in all three languages.

## Design team brief example

> Design a community library booking page. Deliver a user flow, mobile layout,
> accessibility checklist and implementation plan. Design should propose
> hierarchy and visual tokens; engineering should identify constraints; review
> should identify missing states. The coordinator should synthesize the plan.

One round plus coordinator synthesis is the default. Choose your own providers.
This generates discussion artifacts, not Figma files or executable code changes.
