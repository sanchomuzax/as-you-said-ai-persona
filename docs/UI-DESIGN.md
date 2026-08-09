# UI/UX Design Direction

Status: recorded 2026-08-09, from the stakeholder's visual concept.
Reference prototype: [`docs/mockups/three-panel-prototype.tsx`](mockups/three-panel-prototype.tsx)
(React/Tailwind sketch — a **visual reference**, not the implementation target; see
§5 on the stack).

The interface has to convey scientific rigour and stay usable by a media
professional, not a developer. Everything below serves that pair of goals.

## 1. App shell — three panels, one screen

- **100vh, no global scrolling.** Panels scroll internally.
- Three-column grid: navigation · workspace · inspector.

## 2. Panel 1 — Navigation (dark)

- Project selector dropdown at the top (the project scopes everything below).
- Menu: Runs · Personas · Interview · Models & Calibration.
- Bottom: **live token budget widget** with a progress bar and spend.

## 3. Panel 2 — Workspace (light)

- Header: dynamic title (run name), plus live run state (concurrent calls,
  cache-hit rate).
- **Dual view toggle** — the central idea of this design:
  - **Analyst (default)**: clean charts, distribution bars, no machinery.
  - **Engineer (X-Ray)**: data-dense. Under each answer, expandable metadata —
    rendered prompt payload, raw output, model version, tokens, permutation order.
- This split is how one interface serves both audiences without dumbing down
  either: the researcher sees findings, the auditor sees evidence.

## 4. Panel 3 — Inspector (slide-over)

- Hidden by default, opens on context (clicking a persona or a response).
- **Persona Provenance Card**: avatar, demographic chips, grounding badge with
  source attribution, system metadata (version, base model, prompt mode).
- **Evidence audit**: when an answer is missing, this panel explains *why* the
  model abstained, using calibration data.

## 5. Stack: visual target vs. implementation

The reference prototype is React + Tailwind + lucide-react. **The platform is
vanilla JS with no build step**, running on a Raspberry Pi 5. Adopting React and
a component library would be a significant architecture change with real costs
(build pipeline, bundle size, CPU on the Pi) and no functional gain — the layout,
the toggle, the slide-over and the cards are all reproducible in plain CSS/JS.

**Decision: treat the prototype as a visual specification, implement in the
existing stack.** Revisit only if the UI outgrows what vanilla JS can maintain.

## 6. Special patterns

- **Evidentiary gap**: explicit abstention renders as an **amber card, never a red
  error** — heading "Tartózkodás (Abstention)" with the reason. Abstention is
  correct behaviour, not failure.
- **Live progress**: during a run, real-time feedback — counters ticking, cells
  turning green, cost updating.

## 7. Where the mockup contradicts our methodology (must not be copied)

The prototype contains placeholder content that would break our own rules if it
shipped as-is. Recorded so nobody implements it faithfully:

1. **`Temp: 0.2`** — our protocol runs persona cells at **temperature 1.0**
   (the natural spread is the measurement; only the evaluation judge runs low).
   A UI that displays or implies 0.2 as normal would mislead.
2. **"Grounded profil · Nem-fiktív generálás"** — our personas are demographic
   anchor-core profiles, **not** VoC-grounded. Claiming non-fictional grounding
   for them is exactly the over-claiming the research corpus warns against
   ("the central risk of AI personas is not inaccuracy, but implicit
   limitations"). The badge must render the **actual** grounding state, including
   an explicit *ungrounded* variant, and must never appear green by default.
3. **"A rendszer explicit tartózkodásra kényszerítette az ágenst"** — we do not
   force abstention; the model may declare its knowledge boundary. The wording
   has to describe what actually happened, or the audit trail lies.
4. **"85%-ban invalid választ ad"** as a generic caption — invalid rates are
   measured per model and per question; the UI must show the measured value or
   say it is unknown, never an illustrative number.

## 8. Relationship to existing work

Already shipped and consistent with this direction: token budget widget,
amber abstention treatment, provenance card, self-explaining metric tooltips,
cache-hit measurement. The genuinely new elements are the **three-panel shell**,
the **Analyst/Engineer toggle**, and the **slide-over inspector**.
