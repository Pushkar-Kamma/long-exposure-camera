# Still / Long Exposure Camera

A free, installable camera website for iPhone Safari. Combine camera video frames
for 1 to 600 seconds without uploading your images or paying for an Apple
developer account.

**Open the app:** https://pushkar-kamma.github.io/long-exposure-camera/

## On your iPhone

1. Open the published **HTTPS** GitHub Pages link in Safari.
2. Tap **Enable camera** and allow camera access.
3. Tap **Settings** to choose a duration, or enter a whole number of seconds up to 600.
4. Choose **Smooth motion** for water and clouds, or **Light trails** for moving lights.
5. Rest the phone on a tripod or a solid surface, then tap **Start exposure**.
6. Keep the app visible and the screen on. After the shot, tap
   **Save / Share photo**, then **Save Image** in the iPhone share sheet.

If the share sheet does not offer Save Image, download the JPEG or open the
full-size photo, then press and hold to save it. Photos are not automatically
written to the Photos library. Completed shots are saved automatically to the
app's local gallery. Wait for **Saved to your local gallery** before leaving.
If storage fails, use Save / Share or Download JPEG before taking another shot.

To install: Safari **Share > Add to Home Screen > Add**. Open online at least
once and wait for the offline-ready message before using without reception.
iOS may evict cached website storage, so open the app before heading offline.

## Camera-first controls and local gallery

The shutter stays at the bottom of the screen. Settings collapse during a shot,
and the capture screen shows both elapsed time and remaining time. Duration,
stacking mode, shutter delay, and quality are remembered on this device. Camera
device identifiers are not stored.

Tap **Gallery** to browse completed shots, including explicitly labelled partial
exposures. Open a photo to share it, download the full-size JPEG, or delete it
from the gallery after confirmation. Brightness adjustments update the same
gallery entry rather than creating duplicates. Thumbnails are loaded in pages
of 12, and full-size photos are loaded only when opened. No older photos are
automatically deleted.

If a photo or its latest brightness change is not protected in the gallery, the
app warns before starting another shot. It also requests a browser navigation
warning, but mobile browsers do not always display these warnings. Wait for the
saved confirmation rather than relying on the warning.

The gallery uses IndexedDB in this browser, not iCloud or the Photos library.
Clearing website data, private browsing, and iOS storage cleanup can remove local
photos. Safari and the Home Screen app may have separate storage. Save important
shots to Photos or Files as a backup. Interrupted in-progress exposures cannot
be recovered after iOS terminates the page.

## What the exposure means

- **Smooth motion:** arithmetic mean of video frames in linear-light RGB.
  Longer capture smooths motion and can reduce noise, but does not automatically
  make a static scene brighter.
- **Light trails:** per-channel maximum across video frames. Passing bright
  lights remain in the image.
- Presets: 10, 15, 30, 45, 60, 120, 300 and 600 seconds.
- Brightness can be adjusted from -2 to +3 EV after capturing.
- The capture timer starts with the first received frame, after the shutter delay.
  The result reports the time between the first and last captured frames.
- **Finish & keep** exports early. **Cancel & discard shot** discards the exposure.
- Leaving the app, locking the screen, losing camera frames, or changing camera
  dimensions stops the shot and marks any available result as partial.

This is **synthetic long exposure**, not a sensor shutter held open for minutes.
It uses a video stream requested at up to 1080p and 30 fps, not 48 MP stills or
RAW. Actual dimensions and frame rate depend on the device and browser. There is
no alignment or stabilization of the stacked frames, so a stable phone is
essential. Fast lights can leave gaps between frames. Safari controls camera
focus, sensor exposure and white balance automatically. Dark subjects absent
from the video frames cannot be recovered. This does not replace native Night
mode or a dedicated astrophotography camera app.

Ten minutes of camera and graphics processing uses battery and can heat the
phone. Select 720p for less GPU memory and processing. A screen wake lock is
requested during the exposure. If iOS refuses it, the app displays a warning.
Screen lock or iOS termination can prevent saving a shot.

## Privacy

There are no accounts, analytics, third-party scripts, photo uploads or server
image processing. GitHub Pages serves the app assets. The camera is requested
without microphone access. Photos leave the device only through the user's
chosen sharing action. The app keeps the current render in memory and stores
completed JPEGs and small thumbnails in an on-device IndexedDB gallery. It stores
camera preferences in localStorage. Neither photos nor settings are uploaded.

## Development

Node.js 22 or later:

```powershell
npm start
```

Open `http://localhost:8080` on the computer. A phone needs **HTTPS**, so a plain
HTTP LAN address or an HTML file sent to the phone does not work. The development
server only serves an explicit list of public app assets and listens on loopback.

The deployable app is entirely inside `public`. No build step or runtime
dependencies are required. Publish that directory using any HTTPS static host.

To run the automated checks:

```powershell
npm ci
npx playwright install chromium
npm test
npm run test:browser
```

The browser checks use a synthetic camera in desktop Chromium. They do not
substitute for testing the physical iPhone camera.

The GPU accumulator uses two float32 textures rather than retaining individual
frames. Memory usage is independent of shot length. Float32 sums avoid the
precision stagnation that half-float running averages encounter on long shots.
WebGL2 and `EXT_color_buffer_float` are required.

## GitHub Pages updates

The source lives on `main`. GitHub Pages serves the `gh-pages` branch, containing
only the `public` directory. After committing an update:

```powershell
git subtree split --prefix public -b pages-update
git push origin pages-update:gh-pages
git branch -D pages-update
```

If a push does not queue a Pages deployment, request a build with an authenticated
`POST /repos/Pushkar-Kamma/long-exposure-camera/pages/builds` to the GitHub REST
API. Wait for the new `gh-pages` commit to finish building before treating the
website as updated.

Update the cache version in `public\sw.js` when changing app assets. An installed
service worker waits for open app windows to close before activating a new
version, avoiding mixed old and new files during a shot.

## Native iOS installation

A native app offers better camera controls, but building and installing your own
native app normally requires a Mac with Xcode. Apple's free Personal Team
provisioning expires after 7 days and needs rebuilding and reinstalling. The
website avoids signing, App Store review and the paid developer program.
