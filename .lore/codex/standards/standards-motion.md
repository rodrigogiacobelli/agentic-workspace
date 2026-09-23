---
id: standards-motion
title: Motion standard
summary: The rules every animated element in the application complies with — the
  token scale that supplies every duration and easing, the two properties that
  may animate, the multiplier that turns distance into a cross-fade under
  reduced motion, how a surface React unmounts still plays its exit, and the
  four places where a general rule of motion design is answered differently
  here.
related:
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

## Every duration and easing comes from a token

`:root` in `src/styles.css` defines eight durations — `--d-instant` at 100 ms
through `--d-loop` at 1400 ms — and four easing curves. A rule names a token;
it does not write a number or a keyword. `transition-duration: 0ms` on a press
is the one literal, because an acknowledgement that animates is late.

The token a rule takes is decided by the interaction, not by taste: hover,
focus and colour take `--d-instant`; a toggle or an icon rotation `--d-fast`; a
dropdown or a popover `--d-quick`; an accordion or a tab indicator `--d-base`;
a dialog `--d-enter` in and `--d-exit` out.

A bare `ease`, `ease-in-out` or `linear`, and any duration between 500 ms and
one second, fail the standard. `linear` is for what loops.

## An exit is shorter than its entry

A surface leaves in less time than it arrived and on the opposite curve:
`--e-out` entering, `--e-in` leaving. A menu enters at `--d-quick` and leaves
at `--d-fast`; a dialog enters at `--d-enter` and leaves at `--d-exit`. One
duration in both directions reads as slow.

## Only `transform` and `opacity` animate

Layout and paint properties stay still. `width`, `height`, `top`, `left`,
`margin`, `padding`, `box-shadow` and `filter` are never transitioned: the
active tab's underline is a pseudo-element whose opacity and scale carry it,
not the inset shadow it would otherwise animate.

Two exceptions carry their own reason. `grid-template-rows` animates from `0fr`
to `1fr` for a height reveal — a directory's children in the file tree — and
colour animates for state.

## Every distance goes through `--travel`

A translate is written `calc(<n>px * var(--travel))`. Under
`prefers-reduced-motion: reduce` that multiplier is `0` and the four largest
duration tokens drop to 100 ms, so movement becomes a cross-fade rather than a
shorter slide. A transform with no distance to zero — a scale, a rotation — is
switched off in the same media query.

The state a motion carries survives the switch: a panel still opens, a chevron
still points the other way, a tab indicator still marks the tab.

## A surface React unmounts plays its exit through `useDismiss`

A CSS transition needs the element in the document, and a conditionally
rendered surface leaves it the moment its condition turns false.
`useDismiss` in `src/motion.ts` holds the surface for the length of its exit
and then calls the parent's close, reading the duration from the token so
reduced motion shortens it too. `ContextMenu`, `Palette`, `Prompt`,
`SettingsDialog`, `BranchList`, `WorktreeList`, the terminal's search bar and
each toast take their dismissal from it.

Three things the hook settles that a timer alone does not. A surface shown
again while its exit is still playing has been reused, so its pending close is
cancelled rather than landing on what is now on screen. A surface the parent
drops mid-exit still fires its close, or the state that was showing it stays
set. A dismissed surface takes no more input: the keyboard handlers return
while `closing` is true.

## Four rules that answer a general one differently

Each of these contradicts what motion design usually asks for, and each holds
here for a reason this application carries.

**A menu closes at once when a row is picked.** The exit plays for a dismissal
— Escape, a click outside — and not for an activation, as a platform menu
behaves. What the row did is the acknowledgement, and a fade over it reads as
lag.

**No list staggers.** Every list here either arrives inside a surface that is
already animating, or is filtered as it is typed into. A per-row delay in
either meters the results in behind the keystroke that asked for them.
`--delay-stagger` stays defined for a list that one day appears alone.

**The loading gate has no minimum.** A placeholder appears a second after the
read starts, through an `animation-delay` on `.tree-loading.loading`, so a read
that lands quickly shows nothing. It carries no floor holding it visible once
shown, which a stylesheet cannot express.

**The tooltip leaves in the time it arrives.** Both directions take
`--d-instant`; the curve changes and the duration does not. An exit 30 per cent
shorter is 70 ms, and anything under 80 ms reads as a glitch rather than a
movement.

## What checks it

`prefers-reduced-motion: reduce` is the one state to test in: movement gone,
every state change still legible. The mechanical half is greppable —
`transition` declarations carrying a number rather than a token, a bare easing
keyword, a forbidden property, a translate outside `calc()`, a stray
`will-change`.

Which CSS features the webview parses at all is a platform question, and a
declaration it cannot parse is dropped in silence. `standards-linux-desktop`
names the set and the check.
