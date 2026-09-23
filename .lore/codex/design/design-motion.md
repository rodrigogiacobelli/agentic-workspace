---
id: design-motion
title: Motion design
summary: What motion in this application is allowed to be — the duration scale and
  which interaction takes which token, what each easing curve means, why an exit
  is shorter than its entry, the two properties that may animate, how motion
  yields to input, the delays before anything starts, the thresholds a loading
  indicator obeys, how long a message stays, and the accessibility floor under
  all of it.
related:
  - standards-motion
---

# Motion design

Motion here answers a question the still frame cannot: where a thing came from,
what it turned into, whether the application heard the click. It is never
decoration, and every value below is chosen by what the reader is doing rather
than by taste. `standards-motion` holds how the code expresses these rules and
what checks them.

## Duration

Every discrete transition lands between 100 ms and 500 ms.

Below 80 ms a movement reads as a glitch rather than a motion, so nothing goes
under 100 ms except hover, focus and a colour change. Above 400 ms on a path
the reader repeats, flow breaks — the Doherty threshold — and 500 ms is the
ceiling for any discrete transition whatever.

Which token an interaction takes:

| Interaction | Duration |
|---|---|
| Hover, focus, colour change | 100 ms |
| Toggle, checkbox, icon rotation | 150 ms |
| Dropdown, popover, small expand | 200 ms |
| Accordion, tab switch, inline reveal | 250 ms |
| Dialog or toast entering | 300 ms |
| Dialog or toast leaving | 225 ms |
| Backdrop dim | 300 ms |
| Drawer, side sheet | 375 ms |
| Skeleton shimmer, spinner revolution | 1400 ms |

Duration scales with distance. A 24 px chevron and a full-height drawer never
share a value: 200 ms anchors a card-sized move, and crossing the viewport adds
about 100 ms.

Something that should feel snappier keeps its duration and takes the
emphasized curve. Shortening it instead lands under the floor.

## Easing

A curve says which way time runs.

Entering takes the ease-out curve, and that is the default. Leaving takes
ease-in. Something that starts and ends on screen — a row reordering, a tab
indicator sliding — takes ease-in-out. `linear` belongs to what loops, and to
nothing else: a spinner, a progress bar, a shimmer, a marquee.

Never ease-in on entry. Never `linear` on a discrete transition. Never the bare
`ease` or `ease-in-out` keywords.

## Direction

An exit runs 20 to 30 per cent shorter than its entry, on the opposite curve.
One duration in both directions reads as slow leaving.

A surface enters from where it lives: a menu grows from its anchor, a drawer
from its edge, a toast from its corner.

## Properties

`transform` and `opacity` animate. Nothing else does.

`width`, `height`, `top`, `left`, `right`, `bottom`, `margin` and `padding`
each cost a layout on every frame. `box-shadow` costs a repaint — a shadow that
has to change cross-fades a pseudo-element's opacity instead. `filter: blur()`
is never animated on anything large.

Two exceptions earn their place: `grid-template-rows` from `0fr` to `1fr` is
the one sanctioned height reveal, and colour animates for state.

`will-change` goes on immediately before an animation and comes off
immediately after. It never sits in a stylesheet.

The budget is about 10 ms of work per frame, which is 16.7 ms less the
compositing. A callback that writes layout does not also read it.

## Interruption

New input retargets a running animation. It never queues behind one.

Motion does not block input: nothing becomes unclickable for the length of a
transition. A CSS transition retargets by itself; an animation driven from
script is cancelled and restarted from the value it had reached, never awaited
before the next event is accepted.

## Delays

A delay is a different clock from a duration — how long before anything starts
at all.

A menu or tooltip that opens on hover waits 300 to 500 ms first. Under 150 ms
it fires on a cursor that was only passing; over 500 ms it reads as broken.
Leaving grants 150 ms of grace, so the pointer can cross the gap into the panel
it opened. Once one tooltip in a group has opened, the next opens with no delay
at all, and the delay returns after about 1.5 s without a hover.

A list that staggers gives each item 20 to 50 ms and stops at eight. Forty rows
never stagger.

A filter that runs as the reader types waits 250 ms after the last keystroke.
Validation happens on blur, not on a keystroke.

## Loading

Under one second, show nothing. The previous content holds, dimmed. A table
never blanks to a spinner because a filter changed.

Between one and four seconds, a skeleton stands where the layout is known and a
spinner where it is not. Past four seconds, determinate progress — but only
where it can be measured honestly, because a fabricated percentage is worse
than a spinner. Past ten seconds, say what is happening and offer to cancel or
to finish in the background.

An indicator that has appeared stays at least 500 ms. One that flashes is a
stutter, not progress.

The click is acknowledged in 0 ms — a pressed state, a disabled button, an
optimistic row. Feedback and result run on separate clocks, and only the result
is allowed to be slow.

## Dwell

How long a message stays depends on what it asks of the reader:

| Message | Dwell |
|---|---|
| Short confirmation | 3–4 s |
| Toast with nothing to do | 4–6 s |
| Toast carrying an action | 6–10 s |
| Error, warning, anything destructive | stays until dismissed |

The timer pauses on hover and on keyboard focus, and resumes on leave or blur.
Nothing carrying an action the reader must take expires on its own (WCAG
2.2.1).

## Accessibility

`prefers-reduced-motion: reduce` is honoured by replacing movement with a
cross-fade, not by shortening the slide. What the preference asks about is
travel across the visual field, and a faster slide still travels.

Every state change stays visible under the preference: a panel still opens, and it
does not move to get there.

No parallax, spin, scale-from-zero or multi-axis motion without a way to turn
it off. Nothing flashes more than three times a second (WCAG 2.3.1). Anything
that plays by itself for more than five seconds carries a pause control (WCAG
2.2.2).

Motion never carries information alone. Everything it says is readable from the
still frame.

An animation on a path the reader crosses dozens of times a day is dropped
rather than tuned.

## Four rules answered differently here

Each of these contradicts a general rule above, and each holds for a reason
this application carries.

**A menu closes at once when a row is picked.** The exit plays for a dismissal
— Escape, a click outside — and not for an activation, which is how a platform
menu behaves. What the row did is the acknowledgement, and a fade over it reads
as lag.

**No list staggers.** Every list here either arrives inside a surface that is
already animating or is filtered as it is typed into, and a per-row delay in
either meters the results in behind the keystroke that asked for them.

**The loading indicator has no minimum.** It appears a second after the read
starts, so a read that lands quickly shows nothing. It carries no floor holding
it visible once shown.

**A tooltip leaves in the time it arrives.** The curve changes between the two
directions and the duration does not, because 30 per cent shorter than 100 ms
is 70 ms, and that is under the floor.
