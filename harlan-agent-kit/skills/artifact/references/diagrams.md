# Diagrams in an Artifact

Draw as the engineer who has to live with the decision. A diagram earns its place when a cold reader sees a mechanism they would otherwise assemble from prose: where data flows, which components talk, what changes between two options, what state a request moves through. If a sentence says it faster, write the sentence.

## What to draw

- **The mechanism, not its name.** A box labeled "cache" says less than the prose. The path a request takes through it, the two stores it sits between, and the arrow that disappears when it is removed say what words cannot.
- **Comparing options? Draw the difference.** Two architectures side by side, a before and an after, the one edge each option adds or removes. Separate boxes per option with nothing connecting them is a restated list.
- **Match complexity to the stakes.** A one-hop question is three boxes. A migration that reroutes writes through a queue needs the queue, the writer, the reader, and the ordering arrow.
- **Label the arrows.** `writes`, `invalidates`, `polls every 30s` is information. A legend only when one encoding repeats.

## Mermaid

`<pre class="mermaid">` renders natively on both publish paths. Use it for flowcharts, sequences, and state machines where layout precision does not matter. Keep node labels short. Put the sentence in a `<figcaption>` below.

## Inline SVG

Hand-author `<svg>` with native shapes and `<text>`. No libraries, no external images.

- **Size by `viewBox`.** `viewBox="0 0 W H"` sized to the content, then CSS `max-width: 100%; height: auto`. Wide flows read left to right, layered stacks top to bottom.
- **Theme with `currentColor`.** Strokes, text, and arrowheads inherit the page foreground in both themes. Reserve one literal hue for the element that carries meaning, and check it on both grounds.
- **Arrowheads are markers or polygons.** `<defs><marker>` referenced by `marker-end="url(#arrow)"`, or a small `<polygon>`.
- **Legible text.** 11 to 13px at the drawn scale, `text-anchor` for alignment, a word or three per label.
- **Align to a grid.** Shared baselines and even gaps make a hand diagram read as deliberate.
- **One figure, one claim.** Wrap in `<figure>` with a `<figcaption>` stating what the picture shows. Give the `<svg>` `role="img"` and an `aria-label` with the same claim.
- **Self-contained.** No `<script>`, `<style>`, or `<foreignObject>` inside the SVG. Gradients and `<use>` reference ids in the same fragment.
