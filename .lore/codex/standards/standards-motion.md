---
id: standards-motion
title: Motion standard
summary: How this codebase writes the rules in design-motion — the token scale in
  src/styles.css that every duration and easing is named from, and the one time
  written as a number, a toast's two seconds; the calc form that makes the
  reduced-motion switch work, the pseudo-element that carries the tab indicator,
  the positions a dragged tab and its neighbours take, the hook that lets a surface
  React unmounts still play its exit, how the toast stack holds its toasts, what
  the image viewer animates and what it leaves to the input, the easing every wheel
  scroll goes through, and what checks the result.
related:
  - design-motion
  - standards-code
  - standards-linux-desktop
  - 010-react-frontend
  - 013-app-drawn-chrome-and-tray
binds:
  - src/styles.css
  - src/motion.ts
  - src/notice.ts
  - src/App.tsx
  - src/components/tabs.tsx
  - src/components/ImageView.tsx
  - src/wheel.ts
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

An animation run from script reads the same tokens: `duration()` and
`easing()` in `src/motion.ts` return a token's value as the stylesheet
resolves it, reduced motion included.

A toast's dwell is the one time written as a number: `NOTICE_DWELL_MS` in
`src/notice.ts`, 2000 ms. The reduced-motion query shortens the duration
tokens, and it must not shorten the time a message stays to be read. The
editor's *Reloaded from disk.* banner leaves on the same number (NTF-06).

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
a directory opened while the tree is on screen — from the tree or its keys,
*Show in Explorer*, a breadcrumb's *Reveal in Explorer*, a folder chip, a
paste, a drop or a new folder — and never for the open directories of a tree
built when its workspace or mode comes back, or of a view the Custom panel
switches to (`.tree-branch.open.unfold`). The grid
wrapper that carries it clips its child downwards only, with
`overflow: visible clip`, so a name longer than the panel still scrolls into
view rather than being cut off.

## A dragged tab's translates are positions

`dragTab` in `src/components/tabs.tsx` places the copy of a dragged tab, the
insertion line and the tabs pushed aside to open its gap by writing
`transform` from script, in pixels measured from the strips. Those translates
say where a tab stands rather than how far something travels, so they are not
written through `--travel`: a zeroed multiplier would close the gap that shows
where the tab lands (TAB-14).

The stylesheet attaches the slide only while a strip carries `data-dragging`,
and to the landing copy only once it is released (`.tab-ghost.settling`): both
run on `--d-quick` with `--e-in-out`, and the insertion line slides with its
gap on the same pair after fading in on `--d-fast`. The copy's lifting shadow
sits on a `::before` whose opacity fades as it lands, because `box-shadow` is
not animated. The reduced-motion query
takes `transform` out of those transitions. There each moved tab, the line and
the landing copy fade in at their new place instead: `dragTab` flips
`data-moved` between `a` and `b` whenever one of them moves, and each value
names its own copy of the fade keyframes, which restarts the fade. `dragTab`
reads `--d-quick` through `duration()` to make the move once the copy has
landed.

## `useDismiss` holds a surface React would unmount

A CSS transition needs the element in the document, and a conditionally
rendered surface leaves it the moment its condition turns false. `useDismiss`
in `src/motion.ts` keeps it for the length of its exit and then calls the
parent's close, reading the duration from the token so reduced motion shortens
that too. `ContextMenu`, `Palette`, `Prompt`, `SettingsDialog` with its tab
pages, `CredentialPrompt`, `Confirm`, the terminal's search bar and each
toast take their dismissal from it.

Three things the hook settles that a timer alone does not. A surface shown
again while its exit is still playing has been reused, so its pending close is
cancelled rather than landing on whatever is now on screen. A surface the
parent drops mid-exit still fires its close, or the state that was showing it
stays set. A dismissed surface accepts no more input: its keyboard handlers
return while `closing` is true.

A toast is keyed by an id rather than by its index, because each carries the
state of its own exit and an index hands that state to whichever message moves
up into the slot.

The rich-mode toolbar's paragraph style menu, in `src/editor/toolbar.ts`, is
built outside React. It wears `.menu` and plays the same exit: dismissed, it
takes `is-closing`, stops listening for keys, and removes its element after
`duration("--d-fast")`. Each opening builds a new element, so no pending exit
lands on a menu shown again.

## A toast counts down only while nobody holds the stack

`Notice` in `src/App.tsx` starts a toast's exit through `useDismiss` once
`NOTICE_DWELL_MS` has run, whatever its kind (NTF-01). The timer runs only
while the toast is not held; held, it stops, and it starts again with the
time that was left. `Notices`, the stack around every toast of a window,
holds them all as one while any of three is true (NTF-02, NTF-03):

- the pointer is on the stack: a `mousemove` at a new screen point sets it,
  and one at the point of the last is ignored, since WebKitGTK sends that move
  when something appears under a resting pointer, and a toast that arrives
  there has not been pointed at;
- keyboard focus is inside the stack;
- the window does not have focus: the hold starts from `document.hasFocus()`
  and follows the window's `focus` and `blur`.

A toast that leaves takes focus with it and can leave the pointer over
nothing, and neither sends an event. After every change to the list,
`Notices` asks `document.elementFromPoint` what lies under the last pointer
position and lets go of a hold the stack no longer has, and does the same for
focus. It never takes a hold that way. The hold lives in `Notices` rather than
in `App`, so a window gaining or losing focus re-renders the stack and not
the window.

## The image viewer animates what the reader asks for

`src/components/ImageView.tsx` sizes the picture in pixels, never with a
`scale()`, and pans by scrolling. A zoom step, a fit, an actual size or a
quarter turn asked for by a button, a key or a double-click plays one
animation of the picture's frame
through `Element.animate`: from a transform that puts the frame back where and
how it was drawn to none, on `duration("--d-base")` and `easing("--e-in-out")`.
A new change takes a running animation from its computed transform and
cancels it, so the next one starts from where the frame had got to
(design-motion, Interruption). A scale and a rotation have no distance for
`--travel` to zero, so under `prefers-reduced-motion: reduce` the viewer plays
nothing and the new size and turn land at once.

What the reader drives continuously plays nothing. The viewer's own wheel
listener, registered as not passive, takes a `Ctrl`+wheel before `wheel.ts`
and the webview see it, calls `preventDefault` so the page never zooms, and
writes the new zoom at once; a Shift+wheel it takes the same way and scrolls
sideways at once. A drag writes the scroll offsets on every pointer move under
pointer capture. A fit the viewer works out again as a divider or the window
resizes the tab, and a mirror flip, land without an animation.

## Wheel scrolling is the application's own

`src/wheel.ts` scrolls every surface a wheel scrolls vertically: both editor
views, the diff, the image viewer, the Explorer, the panels, the settings. WebKitGTK animates each
wheel event by itself and starts over at the next, so the stream of small steps
a high-resolution or free-spinning wheel sends moved a page in stalls and
spurts (`standards-linux-desktop`). One listener on the window takes each
vertical wheel event after every surface below it has had the chance, moves the
target of the scroller under the pointer — the nearest one with room left that
way, as the webview chains a scroll outwards — and eases every moving scroller
toward its target once a frame by a fixed share of the distance left, 0.17. At
60 frames a second that is a time constant of about 90 ms, so a page's speed
follows the wheel's: it builds as the wheel spins up, holds while it spins,
and falls away as it coasts.

The share is per frame, not per millisecond. WebKitGTK's frame callbacks arrive
at uneven times while the frames are shown at even ones, and a step scaled by
the callback's interval moved the text unevenly between shown frames.

A move the easing did not make — an editor keeping its place as it measures
the lines coming into view, a split's other pane following — shifts the target
by the same amount, so it is carried rather than undone. A press or a key stops
every glide where it is, as a touch stops a fling. Sideways scrolling, a zoom
(Ctrl), a terminal, whose wheel xterm hands to the program running in it, and
`prefers-reduced-motion: reduce` keep the webview's own scrolling. An event a
surface has already taken, `defaultPrevented` — the image viewer's
`Ctrl`+wheel zoom and Shift+wheel pan — is left alone.

## What checks it

`prefers-reduced-motion: reduce` is the state to test in: movement gone, every
state change still legible.

How smooth a scroll is gets measured frame by frame, with real wheel input, in
the running application; judging it by eye in a development build misses
single dropped frames and cannot be repeated.

The mechanical half is greppable in `src/styles.css` — a `transition`
declaration carrying a number rather than a token, a bare easing keyword, a
property outside `transform`, `opacity`, `grid-template-rows` and colour, a
translate outside `calc()`, a stray `will-change`.

Which CSS features the webview parses at all is a platform question, and a
declaration it cannot parse is dropped in silence. `standards-linux-desktop`
names the set and the check.
