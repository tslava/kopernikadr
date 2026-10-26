# Kopernikadr — roadmap

Status: 2026-10-26. A browser remote (`remote-lite`, served by the phone) works today. Order of
work: **plan 0b (native tablet app) → effects layer → cloud AI → the rest by priority.**

## Owner decisions (2026-10-26)
- **Effects and AI go into the native tablet app (Capacitor), not into `remote-lite`.** They come
  right after plan 0b. `remote-lite` keeps working as is in the meantime.
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

## Effects layer (after 0b)
Effects never change the originals. A project stores layers: what, where, on which frames. The
same canvas renderer draws them in playback and in export. Stickers can be placed over the live
view.

| Feature | Notes |
|---|---|
| **Emoji and stickers (OpenMoji)** | Place, resize, rotate, hold over a frame range. Simple motion: bounce, spin, blink, follow a drawn path |
| **Comics** | Speech/thought bubbles, "BAM!", "PUF!", "ZZZ" captions over a frame range, comic font |
| Particles | Smoke puff (the "vanish" trick), sparks, stars, confetti, rain, snow, explosion flash |
| Whole-movie filters | B&W, sepia, "old film" (scratches + jitter), comic (posterize + outlines), night, VHS |
| Camera moves | Zoom / pan / shake across the 3264×2448 frame. The export is 1440×1080, so there is >2× headroom with no quality loss |
| Transitions, speed | Fade, iris, wipe; speed up / slow down a range, reverse, boomerang |
| Guided tricks | "Vanish" (remove object + auto puff), "Flight" (draw a path, per-frame markers), "Explosion" (flash + shake + BAM + sound) |

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
   - duplicate / hold a frame;
   - insert a frame in the middle; reshoot frame N;
   - reorder, copy and paste frames; reverse a range;
   - trim the start/end;
   - per-frame duration;
   - "shoot on twos" export.
4. **Projects:**
   - projects stored on the phone (shared across devices);
   - save to the tablet gallery (0b);
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
