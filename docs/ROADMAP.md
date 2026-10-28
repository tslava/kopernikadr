# Kopernikadr — roadmap

Status: 2026-10-27. **Done:** plan 0b (probes, PROTOCOL v1, shared remote-core; the Family Link
run on the real devices is still open) and stages 1+2 (the native tablet app: projects, shooting
with onion skin, verified transfer, minimal playback and export to the gallery; tested on an
emulator against a fake camera, the tablet + phone session is still to do) and **stage 3a +
emoji** (2026-10-27, also emulator only; see `docs/diagnostics/20261027-stage3a-emulator.md`).
The browser remote `remote-lite` keeps working as a fallback. Order of work from here: **real-device
run of 3a → stage 3b (insert/reshoot, copy/paste, reverse) → the rest of the effects layer → cloud
AI → the rest by priority.**

## Done: stage 3a + emoji
- Frame strip (112 px tiles, 500 frames stay flat in memory); edit tools: delete with Undo,
  duplicate, hold 1..8 ticks, move, off, trim ("Od tego" / "Do tego"), Cofnij (last 30 edits).
  Edits are non-destructive: an edit list (`cut`) over untouched frames.
- Emoji stickers: 242 curated OpenMoji, place, drag, scale, rotate, shown on a range of frames.
  One canvas renderer draws them on the stage and in the export. Export of the timeline with holds.
- Phone: the 7-day reclaim of acked frames (hourly, 200 frames per pass), the dim after 2 minutes
  idle, a parent screen (3 s hold on the title) with quarantine show/clear. Tablet: the same
  quarantine section on the Diagnostics screen, and "O aplikacji" with the OpenMoji attribution.

## Done: "Zrób naklejkę" (2026-10-28)
- A sticker from a photo of a toy (tablet camera or gallery): the on-device cut-out (MediaPipe
  Interactive Segmenter: tap or stroke, "Dodaj"/"Usuń" brushes), the styles "Naklejka" and "Komiks", a
  new "Moje" tab in the emoji picker, then it works like an emoji (place, drag, scale, rotate, range,
  export). A PNG/WebP with transparency skips the cut. Details: ARCHITECTURE §5.4a; tablet run:
  `docs/diagnostics/20261028-photo-stickers.md`.

## Next: stage 3b
- Insert a frame in the middle and reshoot frame N.
- Copy and paste frames; reverse a range.
- Then the rest of the effects layer below (motion for stickers, comics, particles, filters).

## Open owner questions (from 3a)
- Real use: shoot, edit, add emoji, export, watch in the gallery. Do the "sticker until the end"
  default and the strip size suit a 9-year-old?
- Should a sticker placed "until the end" also cover frames shot after it was placed? Today it
  does not.
- Is the 3 s hold plus the typed answer enough to keep the kid away from the phone's quarantine
  clear, or is a parent PIN needed?
- The g05 camera upgrade waits for stages 1+2 Task 21 and goes first: back up the spool
  read-only, `install -r`, smoke test. The 7-day reclaim starts deleting acked frames on the g05
  only after that install, so the backup comes before it.
- Family Link "Always allowed" for both apps; the release keystore (owner).

## Owner decisions (2026-10-26)
- **Effects and AI go into the native tablet app (Capacitor), not into `remote-lite`.** They come
  after stage 3. `remote-lite` keeps working as is in the meantime.
- **Stickers/emoji: OpenMoji** (SVG, CC BY-SA 4.0), bundled into the app. The attribution
  "OpenMoji – the open-source emoji and icon project. License: CC BY-SA 4.0" goes on an "About"
  screen. No graphics from other apps.
- **AI: a cloud API.** This **overrides** "Out of scope: cloud" in `PROMPT.md` for the AI features
  only. Consequences that must be designed for:
  - photos of the tabletop set (only the table is in frame, no room or people) are sent to the provider;
  - an API key is needed, entered in parent mode and stored only on the tablet, never in the repo;
  - every AI action needs network access and costs money;
  - a provider is not chosen yet (candidates: Gemini image editing, OpenAI image edit).
- AI features chosen: **remove a hand/stick (inpainting)** and **generate a background**. Frame
  interpolation ("draw the missing frames") is not chosen for now: kids' moves are big steps and
  interpolation smears them (see "Later").

## Effects layer (after stage 3)
Effects never change the originals. A project stores layers: what, where, on which frames. The
same canvas renderer draws them in playback and in export. Stickers can be placed over the live
view.

| Feature | Notes |
|---|---|
| **Emoji and stickers (OpenMoji)** | ~~Place, resize, rotate, hold over a frame range~~ (done in 3a). Still to do: simple motion: bounce, spin, blink, follow a drawn path |
| **Comics** | Speech/thought bubbles, "BAM!", "PUF!", "ZZZ" captions over a frame range, comic font |
| Particles | Smoke puff (the "vanish" trick), sparks, stars, confetti, rain, snow, explosion flash |
| Whole-movie filters | B&W, sepia, "old film" (scratches + jitter), comic (posterize + outlines), night, VHS |
| Camera moves | Zoom / pan / shake across the 3264×2448 frame. The export is 1440×1080, so there is >2× headroom with no quality loss |
| Transitions, speed | Fade, iris, wipe; speed up / slow down a range, reverse, boomerang |
| Guided tricks | "Vanish" (remove object + auto puff), "Flight" (draw a path, per-frame markers), "Explosion" (flash + shake + BAM + sound) |

## Later: after "Zrób naklejkę"
| Feature | Notes |
|---|---|
| Sticker styles "Pufy" and "Błysk" | Puffy and shiny looks for the sticker, next to "Naklejka" and "Komiks" |
| A movie frame as the sticker source | Cut a toy out of a frame already shot, in addition to camera and gallery |
| Cloud "cartoon" | Redraw a photo as a cartoon in the cloud (a cloud AI feature, same rules as below) |
| "Get into the cartoon" | Selfie segmentation (MediaPipe): cut the kid out of a photo to put her into the movie |
| Hand in frame | Warn or auto-skip when a hand is in the shot, with MediaPipe hands (on-device) |
| Clap to shoot | Take the shot on a clap, with the MediaPipe audio classifier (on-device) |

## Cloud AI (after the effects layer)
| Feature | Notes |
|---|---|
| **Remove hand/stick** | The parent or kid paints a mask over the frame and the cloud inpaints it. The result is a new, non-destructive variant of the frame that can be reverted to the original. A deterministic alternative is a clean plate (shoot an empty set, restore pixels from it), which works offline and is offered first when a clean plate exists |
| **Generate a background** | Text prompt ("space", "underwater") → background image; the figure is cut out (segmentation or chroma key) and composited. Backgrounds are stored per project and reused across frames |
| Safety | A parent-mode toggle enables AI; a confirmation on first use explains that photos go to the cloud; a per-project spend counter; requests and results are cached so a re-export never pays twice |

## Next by priority (from the Stop Motion Studio / Dragonframe review)
1. **Shooting aids:**
   - live ↔ last frame toggle;
   - loop of the last 5 frames + live;
   - 2–3 onion layers;
   - **difference** onion mode;
   - grid / safe area;
   - capture with the space bar / volume key / Bluetooth shutter;
   - interval timer;
   - 2× zoom loupe.
2. **Exposure quality:**
   - frozen exposure time rounded to a multiple of 10 ms (50 Hz mains in PL → no LED flicker);
   - "light changed" warning;
   - "hand in frame" warning (on-device);
   - histogram / clipping indicator in parent mode;
   - test shot that does not enter the movie.
3. **Editing:**
   - ~~duplicate / hold a frame~~ (done in 3a);
   - insert a frame in the middle; reshoot frame N (3b);
   - ~~reorder~~ (done in 3a), copy and paste frames; reverse a range (3b);
   - ~~trim the start/end~~ (done in 3a);
   - ~~per-frame duration~~ (done in 3a, as hold);
   - ~~"shoot on twos" export~~ (dropped: per-frame hold covers it).
4. **Projects:**
   - projects stored on the phone (shared across devices);
   - ~~save to the tablet gallery~~ (done in stages 1+2);
   - project ZIP backup;
   - cleanup of saved movies' frames on the phone;
   - movie gallery with covers.
5. **Quality in post:** deflicker and stabilization at export (reuse `Metrics` / `Aligner`),
   multi-exposure averaging against noise in dim rooms, GIF / 16:9 / 4K export.
6. **Sound (v2):** voice-over, sound library, effect sounds tied to stickers, lip sync later.
7. **Planning:** storyboard cards (a simplified X-sheet), reference video next to the live view,
   drawing guide layers (arcs and spacing marks) over the live view.

## Later / not now
- AI frame interpolation (RIFE/FILM). Only as an optional "smooth" export or "fill one missing
  frame"; it smears large motions.
- Motion control, DMX lighting, DSLR tethering, several cameras at once: studio tools, not for
  this rig.
