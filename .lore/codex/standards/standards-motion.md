---
id: standards-motion
title: Motion standard
summary: How this codebase writes the rules in design-motion — the token scale in
  src/styles.css that every duration and easing is named from, the calc form that
  makes the reduced-motion switch work, the pseudo-element that carries the tab
  indicator, the hook that lets a surface React unmounts still play its exit, and
  what checks the result.
related:
  - design-motion
  - standards-code
  - standards-linux-desktop
  - 010-react-frontend
  - 013-app-drawn-chrome-and-tray
binds:
  - src/styles.css
  - src/motion.ts
---

# Motion standard

Motion in this application is CSS. `src/styles.css` holds a scale of duration
and easing tokens at its head and one Motion section at its foot that applies
them; `src/motion.ts` holds the one piece no stylesheet can express.
`design-motion` holds the rules these encode.

## A rule names a token, never a number

`:root` in `src/styles.css` defines eight durations — `--d-instant` at 100 ms
through `--d-loop` at 1400 ms — four easing curves, three delays and the
`--travel` multiplier. A declaration names one of them.

`transition-duration: 0ms` on `:active` is the one literal in the stylesheet,
because an acknowledgement that animates is late.

## Every distance is written through `--travel`

A translate reads `calc(<n>px * var(--travel))`. The reduced-motion query sets
that multiplier to `0` and drops `--d-base`, `--d-enter`, `--d-exit` and
`--d-large` to 100 ms, so a distance written any other way survives the switch
it was meant to answer.

A transform with no distance to zero — a scale, a rotation — is listed in that
same query and turned off there.

## The tab indicator is a pseudo-element

`box-shadow` is not animated, so the underline under the active tab and the
active panel tab is a `::after` whose opacity and horizontal scale carry it,
and the selected tab in the settings dialog's tab column is marked the same
way.

The one height reveal is a directory's children in the file tree, played for
a directory opened while the tree is on screen — from the tree, the
breadcrumb, a paste or a new folder — and never for the open directories of a
tree built when its workspace or mode comes back (`.tree-branch.open.unfold`). The grid
wrapper that carries it clips its child downwards only, with
`overflow: visible clip`, so a name longer than the panel still scrolls into
view rather than being cut off.

## `useDismiss` holds a surface React would unmount

A CSS transition needs the element in the document, and a conditionally
rendered surface leaves it the moment its condition turns false. `useDismiss`
in `src/motion.ts` keeps it for the length of its exit and then calls the
parent's close, reading the duration from the token so reduced motion shortens
that too. `ContextMenu`, `Palette`, `Prompt`, `SettingsDialog` with its tab
pages, `CredentialPrompt`, the terminal's search bar and each toast — the
error notice and the information notice that leaves on its own after 3.5
seconds — take their dismissal from it.

Three things the hook settles that a timer alone does not. A surface shown
again while its exit is still playing has been reused, so its pending close is
cancelled rather than landing on whatever is now on screen. A surface the
parent drops mid-exit still fires its close, or the state that was showing it
stays set. A dismissed surface accepts no more input: its keyboard handlers
return while `closing` is true.

A toast is keyed by an id rather than by its index, because each carries the
state of its own exit and an index hands that state to whichever message moves
up into the slot.

## What checks it

`prefers-reduced-motion: reduce` is the state to test in: movement gone, every
state change still legible.

The mechanical half is greppable in `src/styles.css` — a `transition`
declaration carrying a number rather than a token, a bare easing keyword, a
property outside `transform`, `opacity`, `grid-template-rows` and colour, a
translate outside `calc()`, a stray `will-change`.

Which CSS features the webview parses at all is a platform question, and a
declaration it cannot parse is dropped in silence. `standards-linux-desktop`
names the set and the check.
