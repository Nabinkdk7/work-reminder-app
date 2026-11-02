# Work Reminder — Mobile

A premium, installable mobile web app built from the Work Reminder browser
extension. Same reminders, same rich chimes, same natural text-to-speech voice —
rebuilt for phones with a responsive liquid-glass interface and mobile-first
tools.

**Dev by [Nabin Khadka](https://nabinkhadka.com)** ·
[GitHub Repository](https://github.com/Nabinkdk7/Work-Reminder-Extension)

---

## Features

### Reminders
- Daily, weekday, custom-day and one-off reminders.
- Per-reminder sound, voice, notification and enabled toggles.
- **Quick reminder** chips (5 / 10 / 15 / 30 / 60 minutes) for instant nudges.
- **Suggested workday** builder based on your office hours, with a preview
  before anything is added.
- Snooze (respects your default snooze length), mark done, edit, duplicate and
  delete.
- Missed reminders are caught up for up to 10 minutes after the phone wakes.
- Do Not Disturb: 30 minutes, 1 hour, until tomorrow, or resume instantly.

### Sound & voice
- Fourteen generated WebAudio chimes including the warm three-strike default
  bell (~3 seconds), plus a per-reminder preview button.
- Natural female, male or system voices with English, Nepali and Hindi
  language preferences, speed and volume control.
- Speech text is normalized (emojis, `&`, punctuation) without altering the
  stored reminder text.
- Audio is unlocked on the first tap, as required by iOS Safari.

### Mobile tools
- Live next-reminder hero with countdown, snooze and done actions.
- Today timeline with progress and one-tap completion.
- Office hours summary and editor.
- Live clock, screen-time tracking and a persistent stopwatch with laps.
- Stopwatch updates at animation-frame speed with centisecond precision, and
  keeps exact elapsed time across pause, reload and returning to the app.
- Bundled Inter variable font (latin + latin-ext) for crisp, consistent text
  offline; other scripts use the platform font.
- Optional screen wake lock while focusing.
- Haptic feedback, dark / light / auto themes and 12 / 24-hour time.
- Search and category filters for large schedules.
- Full JSON backup: share/download on mobile and restore with confirmation.
  Backups are compatible with the browser extension's data shape.

### PWA
- Installable to the home screen on Android, iPhone and iPad.
- Offline app shell through a service worker.
- System notifications with **Mark done** and **Snooze** actions.
- Safe-area aware layout, 44 px touch targets and responsive sheets.

### App updates
- The app checks `version.json` when it opens, when it returns to the
  foreground, every 30 minutes while open, and from **Settings → App updates**.
- A **home-screen update banner** and an optional *“Update available”*
  notification tell existing users when a new Vercel deployment is live.
- **Update now** installs the waiting service worker, keeps all reminders and
  settings, reloads the latest build, and then sends a one-time *“Work Reminder
  updated”* notification with a **What’s new** sheet.
- If a device never shows the update, closing and reopening the installed app
  performs the same switch.

---

## Deploy to Vercel

There is **no build step and no dependencies** — Vercel only has to serve static
files.

### Option A — Vercel dashboard (recommended)

1. Push this folder (or the whole repository) to GitHub.
2. In Vercel, choose **Add New → Project** and import the repository.
3. If the app lives in a subfolder, set **Root Directory** to `workreminderapp`.
4. Framework preset: **Other**. Build command: leave empty. Output directory:
   leave empty (or `.`).
5. Deploy. Open the `https://…vercel.app` URL on your phone.

### Option B — Vercel CLI

```bash
cd workreminderapp
npx vercel --prod
```

`vercel.json` already sets a no-cache service worker and `version.json`, the
manifest content type and basic security headers.

### Publishing an update

1. Bump `version` in `version.json` and `APP.version` in `shared.js`.
2. Bump `VERSION` in `sw.js` so the service worker cache changes.
3. Update the `notes` array in `version.json` with short, user-facing changes.
4. Deploy. Open the app (or wait for the next automatic check) and tap
   **Update now** on the update banner.

> Service workers and notifications require **HTTPS** (or `localhost`). Vercel
> provides HTTPS automatically.

---

## Install on your phone

**Android (Chrome / Edge)**
1. Open the deployed URL.
2. Tap **Install** in the app, or the browser menu → **Install app**.
3. Launch it from the home screen.

**iPhone / iPad (Safari)**
1. Open the URL in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Launch it from the home screen.

After installing, open **Settings → Notifications & sound → Enable
notifications** and allow the permission.

---

## How mobile alerts work

The web platform is not a native alarm service. Work Reminder therefore uses two
layers:

1. **Foreground engine** — while the app is open (or in a background tab that
   the browser keeps alive) it checks every second, shows the in-app alert,
   plays the chime, speaks the message and vibrates.
2. **System notifications** — when permission is granted, a notification with
   Done / Snooze actions is posted through the service worker.

**For exact-time alerts, keep the app open or installed and running.** Phones
aggressively suspend background web apps; a closed PWA cannot guarantee a chime
at an exact minute. Installing the app and allowing notifications gives the
most reliable experience available on the web.

---

## Local development

```bash
cd workreminderapp
npx serve .
# or
python -m http.server 8080
```

Then open `http://localhost:8080`. A plain `file://` open works for layout, but
the service worker and notifications need `http://localhost` or HTTPS.

### Project structure

```
workreminderapp/
├── index.html            App shell and all views
├── app.css               Liquid-glass responsive UI
├── app.js                Controller: storage, alarms, notifications, PWA
├── shared.js             Normalization, scheduling, time and voice helpers
├── sounds.js             WebAudio chime engine
├── voice.js              Web Speech text-to-speech engine
├── sw.js                 Offline cache, update handoff + notification actions
├── manifest.webmanifest  PWA manifest and shortcuts
├── version.json          Latest version and release notes for update checks
├── vercel.json           Static hosting headers
├── icons/                App icons (any / maskable / Apple touch / badge)
├── fonts/                Bundled Inter woff2 files + OFL license
└── README.md
```

Data is stored locally in `localStorage` under `workreminderapp:v1`. Nothing is
sent to a server. Use **Settings → Backup & data** before changing phones.

---

## Browser support

| Browser | App | Sound | Voice | Notifications | Install |
| --- | --- | --- | --- | --- | --- |
| Chrome / Edge (Android) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Safari (iOS 16.4+) | ✅ | ✅ | ✅ | ✅ (installed) | ✅ |
| Chrome / Edge / Firefox (desktop) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Safari (macOS) | ✅ | ✅ | ✅ | ✅ | ✅ |

Voice availability depends on the voices installed on the device. If a
requested gender is unavailable, the app reports it instead of substituting the
opposite voice.

---

## Privacy

- No accounts, analytics, trackers or network calls for app data.
- Reminders, settings and screen-time stats stay in the browser.
- Backups are files you create and choose where to send.

---

## Credits

Built and maintained by **Nabin Khadka** — [nabinkhadka.com](https://nabinkhadka.com).

If Work Reminder helps your day, star the
[GitHub repository](https://github.com/Nabinkdk7/Work-Reminder-Extension).
