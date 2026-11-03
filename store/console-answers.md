# Play Console: App content answers (draft)

Applies to both apps unless marked. Apps: **Kopernikadr** (tablet, `pl.slava.kopernikadr.remote`) and **Kopernikadr Camera** (phone, `pl.slava.kopernikadr.camera`). Both: minSdk 31 (Android 12), targetSdk 36. Facts below were checked in the manifests, `remote/android/app/build.gradle` and the docs. Items marked **FLAG** are uncertain and need the owner's decision or a check in the live console wording.

## Store settings
- **App or game:** App (both).
- **Category (recommend):** **Art & Design** for both. Reason: the product is a creative tool (making movies, drawing stickers). "Education" would invite Play's educational-content expectations and reviewers asking for learning outcomes. Alternative worth a look: "Video Players & Editors", but it targets a general audience and weakens the family positioning.
- **Tags (pick from Play's list, up to 5):** Art & Design, Video editor / Animation (if offered), Drawing, Creativity, Photography. Use only tags the console offers.
- **Contact:** email TBD (owner), website TBD (GitHub Pages of `tslava/kopernikadr-site`).
- **Free / paid:** Free. Cannot be changed to paid later.

## Privacy policy
- URL: **TBD** (planned: GitHub Pages of `tslava/kopernikadr-site`, e.g. `https://tslava.github.io/kopernikadr-site/privacy`). Must be a public, non-PDF, non-geofenced page, in the app's main language at least; same URL for both apps is fine.
- Content to cover: no data collected or shared; photos and movies stay on the user's own devices; local-network transfer between the user's phone and tablet; camera permission purpose; no ads, accounts, analytics; third-party components (OpenMoji, MediaPipe) run on-device; contact address; children's use (no data from children is collected).

## App access
- All functionality is available without login or restricted access. Choose "All functionality is available without special access."
- Note for reviewers (optional free text): "The camera app turns a phone into a camera and needs the tablet app on the same Wi-Fi. The tablet app can be reviewed alone: create a movie and add emoji stickers; shooting needs the phone app on the same network."
  - **FLAG:** a reviewer with one device may not see the shooting flow. Consider a short video link in the review notes.

## Ads
- **Does your app contain ads?** No (both). No ad SDKs.

## Content rating (IARC questionnaire)
- **Category:** "All other app types" (not game, not social, not news). Both apps.
- Answer **No** to: violence, blood, fear/horror, sexual content, nudity, profanity, crude humor, drugs/alcohol/tobacco, gambling and simulated gambling, hate/discrimination, controlled substances.
- **User interaction / user-generated content:** The user creates movies and stickers from their own photos, but nothing is shared with other users: no chat, no social features, no uploads, no user-to-user communication. Answer: users **cannot** interact or exchange content with each other; **no** sharing of user-generated content; **no** sharing of location; **no** purchases; **no** unrestricted internet access/web browsing.
- Digital purchases: No.
- Expected rating: **Everyone / PEGI 3 / USK 0** (final result comes from IARC).
- Notes: stickers are OpenMoji emoji (no violent or sexual set was curated: 242 selected). **FLAG:** the emoji set is "curated", so confirm it contains no weapons, alcohol or similar emoji; if it does, IARC answers stay "No" for the app as such (symbols, not depictions), but check before answering.

## Target audience and content
- **Target age groups (recommend):** **6-8 and 9-12.** Do not tick 13+ and do not tick 5 and under. Reason: UI and tasks are written for 6-12; the parent drawer and the first setup (two devices, Wi-Fi) are for parents, which Play treats as "also appeals to a general audience", not a reason to add an age group. Adding 13+ makes the apps "mixed audience" and gives no benefit here.
- **Does the app appeal to children?** Yes.
- **Consequence: Families Policy applies** (apps for children). What this means for us:
  - No ads, no ad SDKs: OK.
  - No sensitive data/permissions beyond what is needed: camera is needed for the camera app's function; no location, contacts, microphone, storage-wide access.
  - No collection of personal data from children, and no identifiers: OK. (No Advertising ID, no accounts.)
  - Data safety must match and the privacy policy must be present: planned.
  - Apps for children must not use APIs/SDKs not approved for child-directed services: only MediaPipe (on-device) and Capacitor (webview shell); neither sends data. **FLAG:** Play now asks to declare whether SDKs are on the "Families self-certified" list; MediaPipe tasks-vision is on-device only, but check the console's SDK list prompt.
  - "Designed for Families" program: optional; apply after approval if the owner wants the badge (requires stricter review).
- **Store listing appeal to children:** listing avoids misleading claims, no ads wording, no trademarked characters.
- **FLAG (owner):** the tablet app is "landscape only"; irrelevant to rating, but screenshots must match.

## Data safety form

**Overall answers (both apps):**
- Does your app collect or share any of the required user data types? **No.**
- Is all of the user data collected by your app encrypted in transit? Not applicable (no data collected). See reasoning below for the local transfer: it is plain `http://`/`ws://` on the home LAN (cleartext allowed by the tablet's network security config, `remote/android/app/src/main/res/xml/network_security_config.xml`).
- Do you provide a way for users to request that their data be deleted? Not applicable (no data collected). In the app, users delete their movies and stickers themselves; uninstalling removes all app data.
- Data types collected: **none.** Data types shared: **none.**
- Independent security review: No. Committed to Play Families Policy: Yes.

**Reasoning (state it in the owner's notes, not in the form):**
- Google's definition: "collect" means transmitting data **from the app off the user's device** to the developer or a third party; "share" means transferring it to a third party. Data processed **only on the device** is not collected. Data sent to a service provider that processes it on the developer's behalf counts as collected, with limited exemptions.
- Camera app: photos are taken on the phone and sent over HTTP/WebSocket on the local Wi-Fi to the user's own tablet. The server on the phone is the app's own; the tablet is a second device of the same user running our app. No data reaches the developer, a server, a cloud, or any third party.
- Tablet app: the only network destinations are the camera on the LAN (`http://<phone-ip>:8765/...`, discovery via NSD/mDNS). There are no other URLs in the code (only the CC BY-SA license link shown as text in the "About" screen). MediaPipe segmentation runs on-device; its model (`interactive_segmentation.task`) is bundled in the APK assets, not downloaded at runtime.
- No analytics, crash-reporting, ad, or login SDKs are present (checked in the Gradle files and sources).
- Conclusion: **no data collected, no data shared.** Declare "No data collected" and "No data shared" for both.
- **FLAG (uncertainty):** Google's help text does not explicitly cover device-to-device transfer inside one user's home network between two installs of the same developer's apps. The reading "data leaves the device only to the user's own other device, not to the developer/third party, so it is not collection" matches the definition's wording and common practice for local-network apps, but it is an interpretation. If Play review disagrees, the fallback declaration would be: **Photos and videos** (collected: No for the developer; processed ephemerally; not shared). Keep the privacy policy explicit about the local transfer so the two documents agree.
- **FLAG:** the camera server on the phone is reachable by other devices on the same Wi-Fi (session handshake exists, but traffic is cleartext). Not a data-safety item, but the privacy policy should say "use your own trusted home network" and the owner may want to harden this later (see backlog candidates in the report).
- Both apps set `android:allowBackup="false"` (tablet changed 2026-11-03: Auto Backup is capped at 25 MB per app, too small for movies, and a kids app should not copy data to the cloud).

## Permissions

| App | Permission | Why |
|---|---|---|
| Camera | `CAMERA` | Taking the photos for the movie. Runtime prompt; the app shows "Ask a parent to allow the camera". |
| Camera | `INTERNET` | Android requires it to run the HTTP/WebSocket server and accept connections from the tablet on the local network. No traffic to the internet. |
| Camera | `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Show the "No Wi-Fi" screen and find the phone's address on the home network. |
| Camera | `CHANGE_WIFI_MULTICAST_STATE` | Advertise the camera on the LAN (mDNS/NSD, `_kopernikadr._tcp`) so the tablet finds it. |
| Camera | `uses-feature camera.any` (required) | The app is useless without a camera. |
| Tablet | `INTERNET` | Android requires it to connect to the camera on the local network (HTTP/WebSocket). No other destinations. |
| Tablet | `CHANGE_WIFI_MULTICAST_STATE` | NSD discovery holds a Wi-Fi multicast lock to find the camera. |
| Tablet | (none for storage/camera) | Photos for stickers come through the system camera/photo picker intents; the movie is saved to the gallery through MediaStore. No broad storage permission. |

- No location, contacts, microphone, SMS, accounts or `READ_MEDIA_*` permissions. **FLAG:** verify the final merged release manifests (Capacitor plugins can add permissions) before filling the form; the check above was done on the source manifests only.
- Foreground service declarations: check whether the camera app declares a foreground service; none appears in the manifest permissions list above (no `FOREGROUND_SERVICE*`), so none is needed to declare.

## Other declarations
- **Government apps:** No.
- **Financial features:** None (no payments, loans, crypto, banking).
- **Health features:** None (not a health or medical app, no health data, no Health Connect).
- **News app:** No.
- **COVID-19 / contact tracing:** No (if asked).
- **Advertising ID:** Not used (declare "No"). Targeting Android 13+ requires the declaration; answer No.
- **Account deletion:** not applicable, no accounts.
- **Data sharing for the "Photo and Video permissions" policy:** not applicable (no READ_MEDIA_* permissions).
- **Open-source / attribution:** OpenMoji (CC BY-SA 4.0, shown in "About"), MediaPipe and the MagicTouch model (Apache 2.0, shown in "About"). Keep the attribution in the listing text (already included).
- **Export / US law:** standard answers; the app uses no custom encryption (HTTP only, system TLS not used).
