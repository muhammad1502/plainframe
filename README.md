# Plainframe

Removes metadata from photos on your own device: location, camera and lens details, serial numbers, dates, AI generation data (Stable Diffusion, ComfyUI, NovelAI and others), Content Credentials (C2PA), XMP and IPTC fields, thumbnails and data hidden after the image. Nothing is uploaded. The web version works offline once loaded, and the Android app has no internet permission at all.

## Install on Android

1. On your phone, download [`release/Plainframe-1.2.apk`](release/Plainframe-1.2.apk) (open it on GitHub and tap the download button).
2. Open the file. Android asks you to allow installs from your browser or file manager the first time; allow it, then tap Install.
3. Open Plainframe from your app drawer. You can also share photos to it from Gallery or Google Photos with Share, then Plainframe.

Cleaned photos are saved to `Pictures/Plainframe`. A ZIP goes to `Download`. Requires Android 10 or later.

## Use on iPhone or any browser

Host the repository root on any static host (GitHub Pages: Settings, Pages, deploy from `main` / root). Open the link in Safari, tap Share, then Add to Home Screen. After the first visit it works offline.

## Formats

| Format | Keep quality (lossless) | Redraw |
|---|---|---|
| JPEG | Yes, pixels untouched | Yes |
| PNG, APNG | Yes, animation kept | Yes |
| WebP, animated WebP | Yes, animation kept | Yes |
| GIF | Yes, animation kept | Yes, first frame as PNG |
| HEIC / HEIF | Redrawn | Yes, decoded with libheif |
| AVIF | Redrawn | Yes |
| TIFF | Redrawn | Yes, decoded with UTIF.js |
| BMP, ICO | Redrawn | Yes |

Every cleaned file is read again before you save it, and the details sheet says what, if anything, is left.

## Quality presets (Redraw)

- **Smart** tries qualities from 50% to 95% and keeps the smallest file whose brightness detail still measures at 42 dB or more against the original, a strict line for "looks the same".
- **90%, 70%, 50%** save at that quality for a smaller file.

Every redrawn photo is measured against the original, and the details sheet tells you the result: looks the same, small differences up close, or some loss is visible. PNG output is always lossless.

## What it can't do

Watermarks inside the pixels (such as Google SynthID) and anything visible in the picture stay. AI detectors that judge pixels may still flag an image. "Change fingerprint" (Redraw only) adds a tiny turn, resize and grain so copies are harder to match, nothing more.

## Build the APK

Needs JDK 17+ and the Android SDK (platform 36).

```bash
cd android
./gradlew assembleRelease
```

Without `android/keystore.properties` the release build is signed with the debug key. To sign with your own key, create `keystore.properties` next to `build.gradle`:

```
storeFile=plainframe-release.jks
storePassword=...
keyAlias=plainframe
keyPassword=...
```

Keep that key safe: Android only installs updates signed with the same key.

## Third-party code

- [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.5, LGPL-3.0, unmodified, in `vendor/libheif`
- [UTIF.js](https://github.com/photopea/UTIF.js) 3.1.0, MIT, in `vendor/utif`
- [pako](https://github.com/nodeca/pako) 1.0.11 (inflate only), MIT and Zlib, in `vendor/utif`
