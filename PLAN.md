# Cosmic Fecundity — working plan

A perpetual, watchable visual of Smolin's cosmological natural selection: stars
collapse, every collapse is a new universe inside the black hole, the camera
falls through forever.

**Framing that governs every decision:** physics exists here to make things look
and move correctly. It is scenery, not instrumentation. Nothing is counted,
measured, or reported to the viewer. Something to watch and play with, not a
tool for testing a theory.

---

## Where things stand

- **Live file:** `fecundity.html` — single self-contained HTML, no dependencies,
  no build step. In git.
- **Repo branch:** `claude/cosmic-fecundity-simulation-nqqwor`, tip `b4a1f14`.
  Contains the earlier full N-body/multiverse codebase (`src/`, `tools/`).
  The user said they are not reusing that code — but they *did* like many of its
  realistic and accurate aspects. Port behaviours, not files.

### What is already right (do not regress)

- The camera transition. Hard-won, measured, correct. See "Traps" below.
- Recursion: black hole contains a universe, promoted to root on the way through.
  Bounded at ~10–13 live universes; depth costs nothing.
- One black hole = one universe, at the moment of collapse. No mass threshold.
- Inflation as a scale factor: space occupies its full extent from the first
  instant, separations grow. No explosion from a point.
- Remnants inherit their progenitor star's orbit exactly.
- Nucleus grows from a seed rather than appearing at final mass.
- Planets survive the collapse (the clearest "this is a black hole" signal).
- Adaptive resolution under sustained slow frames.

### What the user says is wrong

Verbatim: *"it doesn't feel realistic enough, the blackholes don't look
realistic, the gravity seems fake, the orbits seem fake, the extensive use of
primitive shapes like circles and rings make everything feel like more of
digital artwork than a cool realistic thing when realistic could be done for the
same cost."*

Look direction chosen: **grounded but vivid** — correct geometry and motion,
astrophysical hues, but saturation/brightness kept striking rather than
documentary.

---

## Stage 1 — the look — DONE

1. **Inclination.** Every universe gets a tilt and a position angle, so discs,
   orbits, dust lanes and accretion discs all project as ellipses. Each mote
   carries a precomputed `cz`, so the bulge stays a rounded ellipsoid while the
   disc foreshortens fully.
2. **Every stroked circle gone.** Planet orbits are shown by the trail the
   world leaves; supernovae are torn shells of ejecta; the photon ring is baked
   out of beamed light rather than stroked.
3. **Real black holes**, baked per inclination into a texture — see below.
4. **Astrophysical colour and real darkness.** Warm bulge, blue-white arms,
   pink Hα knots, an unresolved haze layer so the arms are luminosity rather
   than glitter, and dust lanes silhouetted in front of all of it.

### How the black hole is built

Six quantised inclinations x two passes = twelve textures, baked once at
startup at 1024px covering ±4.9 shadow radii. Each carries the near half of the
disc (in front of the shadow), the far half lensed up and over the top, the
secondary image squeezed into a crescent underneath, and the photon ring. The
sense of rotation is a horizontal mirror of the same texture, so it costs
nothing extra. Per frame a hole is two blits.

## Stage 2 — real gravity (next)

Replace the kinematic rotation curve with actual forces: Barnes-Hut quadtree,
gas that cools and clumps, stars igniting where density crosses a threshold
rather than on a timer, remnants inheriting real momentum. Structure emerges
instead of being authored.

**Known failure to avoid:** a previous pure-N-body attempt ejected every star
before it could collapse (259 escapes, 0 deaths in 150 s, no black holes ever
formed). Stars condensed at stagnation points, were born near rest, plunged
radially, and gained energy from the starburst breathing mode.
**Mitigation:** a fixed halo potential holds the disc bound and sets the
rotation curve; N-body handles local dynamics on top. Standard practice.
**Gate:** prove it sustains star → collapse → child universe over several
minutes *before* building any of the pretty layer on it.

Barnes-Hut was previously validated: root mass exact to 7 significant figures,
2.9% mean relative force error at θ=0.85, ~15 ms for a 6000-body pass.

## Stage 3 — interaction

- Drag to pan, wheel to zoom about the cursor.
- Click any black hole to dive into it.
- Back out to the parent — **needs an ancestor stack**; parents are currently
  discarded at the swap.
- Pause and time-rate control.
- Current auto-dive becomes attract mode, resuming when input stops.

## Explicitly not returning

Gene drift statistics, sparklines, lineage tree, event log, mass-conservation
ledger, soak/selection/sweep tooling. None of it. No numeric readouts anywhere.

## Structure

Develop as ES modules; ship one self-contained file via a concat build. No build
step required to run it.

---

## Traps — things already fixed that must not be reintroduced

- **`CHILD_FILL = 0.28` is load-bearing.** It sets how much of the horizon the
  child universe fills. The horizon clears the screen at ~1074px; natural
  framing is 299px. Near 1.0 those moments are 4× apart, which forces a reverse
  zoom at the end of every dive. At 0.28 they coincide, so the camera plunges
  straight through without slowing or backing up. Two earlier attempts failed
  because I worked around this number instead of changing it.
- **The swap must be pixel-exact.** On promotion, `zoom = zoom / framingZoom`
  reproduces the child at exactly the size it was already drawn, even if the
  frame overshoots. Never reset zoom to 1.
- **Never decelerate into the transition.** Easing zoom to a stop while streaks
  imply speed reads as broken. Zoom must never decrease.
- **Never fade the parent out to hide the swap.** It reads as a fade-out/fade-in
  rather than passing through anything. Keep the shadow fully opaque so it
  genuinely engulfs the screen; use the `veil` (black held over the backdrop
  after the swap, fading up) so the frame after is identical to the frame before.
- **No flash.** Removed. The swap is exact; anything drawn to mark it only draws
  attention to a non-event.
- **Cull on actual overlap.** Both the universe and hole culls once had an
  `if (size < HALFDIAG) return` escape hatch, which drew holes tens of thousands
  of pixels off-screen at deep zoom.
- **Streak decimation must carry the missing light.** Thinning motes to a third
  without boosting the survivors reads as a dimming, not as speed.
- **Warp cost is fill-rate.** Streaks were 66.7 ms/frame before decimation,
  occlusion skipping, and length caps brought it to 16.7 ms.
- **The whole piece is fill-rate bound**, not CPU bound. At quarter resolution
  it locks to 60 fps. Optimise overdraw, not arithmetic.

### From Stage 1

- **Bake the accretion disc; never stamp it per frame.** Sprite stamping along
  the arcs beads up visibly unless the stamps overlap several times over, and
  at that overlap it costs the whole frame budget. The shape depends only on
  the inclination, which never changes for a given hole, so it belongs in a
  texture.
- **Beaming belongs in a gradient, not in segments.** On a ring of radius rho
  the line-of-sight velocity goes as cos(azimuth), and cos(azimuth) is exactly
  x/rho — so one horizontal `createLinearGradient` across the ring encodes the
  Doppler boost precisely and the ring strokes in one piece. Chopping the ring
  into segments to vary brightness leaves a seam at every join.
- **Concentric strokes need heavy overlap or they rib.** Strokes have hard
  edges, so a stack of them only reads as a smooth surface when any one of them
  is a small fraction of the local total. At 2.4x overlap the plateaus showed as
  concentric ridges; 260 rings at 7x overlap is smooth.
- **Extend each arc a few hundredths of a radian past its endpoint**, or the
  two halves of the disc leave a hairline seam along the major axis.
- **Clip big texture blits to the screen.** A blit costs its area on the
  destination. Falling into a hole the disc texture is many screens across, so
  push the four screen corners back through the transform and draw only the
  part of the source that can be seen. Worth 14ms a frame on its own.
- **Fade the disc out with the warp; do not switch it off.** A hole the size of
  the screen blinks otherwise.
- **Orient dust along its own orbital tangent.** Oriented to the universe's
  position angle instead, the lanes come out as parallel scratches across the
  picture.
- **The secondary lensed image is an edge-on effect.** Scale it by sin(inc) or
  it becomes a bright blob under every face-on hole.
- **Cull anything that has grown larger than the screen.** A haze blob or a
  dust lane wider than the frame contributes a flat wash and costs a full-frame
  blend to say so.

## Verification method that works

Playwright + headless Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Scripts must live in the repo root (module resolution walks up from the script,
not cwd). Use the `__fecundity.paused` debug hook to freeze a frame so a
screenshot and a state read describe the same instant — async sampling alone
produced several phantom bugs. Measure frame times per phase, not in aggregate.

## Open decisions (defaults if unanswered)

- **Galaxy variety** — spirals only, or also barred / elliptical / irregular?
  Default: vary them; cheap and adds a lot.
- **Idle camera** — drift on its own by default, or sit still until moved?
  Default: drift (attract mode), since this is meant to be watched.
