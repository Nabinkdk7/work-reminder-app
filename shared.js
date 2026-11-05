/* Work Reminder — shared data, time and voice helpers.
   Used by the app (main thread), the sound/voice engines and the tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WR = Object.assign(root.WR || {}, api);
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const APP = {
    name: "Work Reminder",
    version: "1.5.0",
    developer: "Nabin Khadka",
    devUrl: "https://nabinkhadka.com",
    repoUrl: "https://github.com/Nabinkdk7/work-reminder-app",
    storageKey: "workreminderapp:v1",
  };

  const CATEGORIES = [
    { id: "work", label: "Work", desc: "Get things done", color: "#f5b942", icon: "briefcase" },
    { id: "break", label: "Breaks", desc: "Rest & recharge", color: "#3fae7f", icon: "coffee" },
    { id: "meeting", label: "Meetings", desc: "Stay connected", color: "#8b7cf6", icon: "calendar" },
    { id: "personal", label: "Personal", desc: "Health & habits", color: "#4fb3ec", icon: "droplet" },
    { id: "custom", label: "Custom", desc: "Anything else", color: "#94a3b8", icon: "star" },
  ];
  const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

  const SOUNDS = [
    { id: "default", label: "Default Chime", hint: "Warm three-strike bell" },
    { id: "sunrise", label: "Sunrise", hint: "Soft rising chord" },
    { id: "melody", label: "Melody", hint: "Music-box phrase" },
    { id: "pop", label: "Pop", hint: "Bright double pop" },
    { id: "zen", label: "Zen", hint: "Calm singing bowl" },
    { id: "sparkle", label: "Sparkle", hint: "Light pentatonic shimmer" },
    { id: "glass", label: "Glass", hint: "Crystal chime" },
    { id: "gentle", label: "Gentle", hint: "Soft two-note rise" },
    { id: "digital", label: "Digital", hint: "Modern triple beep" },
    { id: "cascade", label: "Cascade", hint: "Falling three-note run" },
    { id: "soft", label: "Soft", hint: "Quiet bell pair" },
    { id: "bell", label: "Bell", hint: "Classic bright bell" },
    { id: "alarm", label: "Alarm", hint: "Firm four-beat alert" },
    { id: "none", label: "None", hint: "Silent" },
  ];
  const SOUND_NAMES = SOUNDS.map((s) => s.id);
  const SETTINGS_SOUND_NAMES = SOUND_NAMES.filter((n) => n !== "none");

  const DEFAULT_SETTINGS = {
    enabled: true,
    voiceEnabled: true,
    notificationsEnabled: true,
    hourFormat: 12,
    defaultSnooze: 5,
    theme: "dark",
    pausedUntil: 0,
    haptics: true,
    keepAwake: false,
    /* The app ships with a male voice by default. `name` pins one specific
       installed voice (voiceURI/name); empty means "best male voice on this
       device", chosen deterministically by the voice engine. `rev` migrates
       older installs that never expressed a voice preference. */
    voice: { gender: "male", language: "en", speed: "normal", volume: 80, name: "", rev: 2 },
    sound: { name: "default", volume: 80 },
  };

  const DEFAULT_OFFICE = {
    start: "10:00",
    end: "18:00",
    lunchStart: "13:00",
    lunchEnd: "14:00",
    days: [1, 2, 3, 4, 5], // 0=Sun .. 6=Sat
  };

  const DEFAULT_SCHEDULE = [
    ["08:10", "Check In — Rigo App", "work", "Please remember to check in on the Rigo App."],
    ["09:30", "Snack Break", "break", "It's time for a snack break."],
    ["11:55", "Return Cup", "personal", "Please don't forget to take your cup to the kitchen floor."],
    ["12:00", "Lunch Time — Stop Tracking", "break", "It's lunchtime. Please remember to stop your time tracking."],
    ["17:00", "Check Out — Rigo App", "work", "Please remember to check out on the Rigo App. Your office hours for today are now over."],
  ];

  function uid() {
    return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  /* Reminder ids are embedded in notification tags, so keep them short and safe. */
  function safeId(id, fallback) {
    const s = String(id == null ? "" : id).trim();
    if (/^[A-Za-z0-9_-]{1,80}$/.test(s)) return s;
    const f = String(fallback == null ? "" : fallback).trim();
    if (/^[A-Za-z0-9_-]{1,80}$/.test(f)) return f;
    return uid();
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function clampNum(v, min, max, fallback) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /* ---- data normalization -------------------------------------------------
     Every value that reaches the UI or the scheduler is normalized first.
     Data can come from an old backup, a hand-edited file or the browser
     extension, so nothing below may assume a field exists. */
  const REPEATS = ["once", "daily", "weekdays", "weekly", "custom"];

  function normalizeReminder(raw, fallbackId) {
    const r = (raw && typeof raw === "object") ? raw : {};
    const repeat = REPEATS.indexOf(r.repeat) >= 0 ? r.repeat : "daily";
    const out = {
      id: safeId(r.id, fallbackId),
      title: String(r.title == null ? "" : r.title).replace(/\s+/g, " ").trim().slice(0, 160),
      message: String(r.message == null ? "" : r.message).replace(/\s+/g, " ").trim().slice(0, 1000),
      time: /^\d{1,2}:\d{2}$/.test(String(r.time || "")) ? fromMinutes(toMinutes(r.time)) : "09:00",
      category: Object.prototype.hasOwnProperty.call(CATEGORY_MAP, r.category) ? r.category : "custom",
      repeat,
      days: Array.isArray(r.days) ? r.days.map(Number).filter((d) => d >= 0 && d <= 6 && d % 1 === 0) : [],
      enabled: r.enabled !== false,
      completed: repeat === "once" ? !!r.completed : false,
      notificationEnabled: r.notificationEnabled !== false,
      voiceEnabled: r.voiceEnabled !== false,
      sound: (typeof r.sound === "string" && SOUND_NAMES.indexOf(r.sound) >= 0) ? r.sound : "default",
      lastCompletedDate: (typeof r.lastCompletedDate === "string" && r.lastCompletedDate) ? r.lastCompletedDate : null,
      lastFiredAt: (typeof r.lastFiredAt === "number" && isFinite(r.lastFiredAt) && r.lastFiredAt > 0) ? r.lastFiredAt : null,
      snoozedUntil: (typeof r.snoozedUntil === "number" && isFinite(r.snoozedUntil) && r.snoozedUntil > 0) ? r.snoozedUntil : 0,
      dndDeferred: r.dndDeferred === true,
      createdAt: (typeof r.createdAt === "number" && r.createdAt > 0) ? r.createdAt : Date.now(),
      updatedAt: (typeof r.updatedAt === "number" && r.updatedAt > 0) ? r.updatedAt : Date.now(),
    };
    out.days = Array.from(new Set(out.days)).sort((a, b) => a - b);
    if (out.repeat === "daily") out.days = [0, 1, 2, 3, 4, 5, 6];
    else if (out.repeat === "weekdays") out.days = [1, 2, 3, 4, 5];
    else if (out.repeat === "once") out.days = [];
    else if (!out.days.length) out.days = [1, 2, 3, 4, 5]; // custom/weekly with no days
    if (out.repeat === "once" && typeof r.at === "number" && isFinite(r.at) && r.at > 0) {
      out.at = r.at;
    } else {
      delete out.at;
    }
    if (out.repeat === "once" && out.completed) out.snoozedUntil = 0;
    return out;
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === "object") ? raw : {});
    const rv = (raw && raw.voice && typeof raw.voice === "object") ? raw.voice : {};
    const v = Object.assign({}, DEFAULT_SETTINGS.voice, rv);
    const rs = (raw && raw.sound && typeof raw.sound === "object") ? raw.sound : {};
    const so = Object.assign({}, DEFAULT_SETTINGS.sound, rs);

    // v1.4.0 migration: the app now defaults to a high-quality male voice.
    // Apply it once to installs created before this build, then remember
    // that the choice was made so an explicit "System default" sticks.
    const voiceRev = clampNum(rv.rev, 0, 99, 0);
    const legacyVoice = voiceRev < 2;
    const gender = legacyVoice
      ? "male"
      : (["default", "male", "female"].indexOf(v.gender) >= 0 ? v.gender : "male");
    const voiceName = legacyVoice
      ? ""
      : (typeof v.name === "string" ? v.name.slice(0, 200) : "");

    return {
      enabled: s.enabled !== false,
      voiceEnabled: s.voiceEnabled !== false,
      notificationsEnabled: s.notificationsEnabled !== false,
      hourFormat: +s.hourFormat === 24 ? 24 : 12,
      defaultSnooze: clampNum(s.defaultSnooze, 1, 1440, 5),
      theme: ["dark", "light", "system"].indexOf(s.theme) >= 0 ? s.theme : "dark",
      pausedUntil: (isFinite(+s.pausedUntil) && +s.pausedUntil > 0) ? +s.pausedUntil : 0,
      haptics: s.haptics !== false,
      keepAwake: s.keepAwake === true,
      voice: {
        gender,
        language: ["en", "ne", "hi", "system"].indexOf(v.language) >= 0 ? v.language : "en",
        speed: ["slow", "normal", "fast"].indexOf(v.speed) >= 0 ? v.speed : "normal",
        volume: clampNum(v.volume, 0, 100, 80),
        name: voiceName,
        rev: 2,
      },
      sound: {
        name: (typeof so.name === "string" && SETTINGS_SOUND_NAMES.indexOf(so.name) >= 0) ? so.name : "default",
        volume: clampNum(so.volume, 0, 100, 80),
      },
    };
  }

  function normalizeScreen(raw) {
    const s = (raw && typeof raw === "object") ? raw : {};
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(s.day || "")) ? String(s.day) : "";
    const ms = Math.max(0, Math.min(24 * 60 * 60 * 1000, isFinite(+s.ms) ? +s.ms : 0));
    const last = Math.max(0, isFinite(+s.last) ? +s.last : 0);
    return { day, ms, last };
  }

  function normalizeStopwatch(raw) {
    const r = (raw && typeof raw === "object") ? raw : {};
    const num = (v) => (isFinite(+v) && +v >= 0) ? +v : 0;
    const laps = Array.isArray(r.laps)
      ? r.laps.map(num).filter((v) => v >= 0).slice(0, 500)
      : [];
    return {
      running: r.running === true,
      startedAt: num(r.startedAt),
      accumulated: num(r.accumulated),
      laps,
    };
  }

  function normalizeOffice(raw) {
    const o = Object.assign({}, DEFAULT_OFFICE, (raw && typeof raw === "object") ? raw : {});
    const time = (v, fb) => /^\d{1,2}:\d{2}$/.test(String(v || "")) ? fromMinutes(toMinutes(v)) : fb;
    o.start = time(o.start, DEFAULT_OFFICE.start);
    o.end = time(o.end, DEFAULT_OFFICE.end);
    o.lunchStart = time(o.lunchStart, DEFAULT_OFFICE.lunchStart);
    o.lunchEnd = time(o.lunchEnd, DEFAULT_OFFICE.lunchEnd);
    o.days = Array.isArray(o.days)
      ? Array.from(new Set(o.days.map(Number).filter((d) => d >= 0 && d <= 6 && d % 1 === 0))).sort((a, b) => a - b)
      : DEFAULT_OFFICE.days.slice();
    return o;
  }

  /* "HH:MM" (24h) -> minutes since midnight */
  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
    if (!m) return 0;
    return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
  }

  function fromMinutes(mins) {
    let m = Math.round(+mins || 0) % 1440;
    if (m < 0) m += 1440;
    return pad(Math.floor(m / 60)) + ":" + pad(m % 60);
  }

  function todayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /* Compare dotted versions ("1.2.0" vs "1.10.0") without string sorting.
     Extra segments are ignored and missing ones count as zero. */
  function parseVersion(v) {
    const parts = String(v == null ? "" : v).trim().replace(/^v/i, "").split("-")[0]
      .split(".").slice(0, 3);
    while (parts.length < 3) parts.push("0");
    return parts.map((part) => {
      const n = parseInt(part, 10);
      return isFinite(n) && n >= 0 ? n : 0;
    });
  }

  function compareVersions(a, b) {
    const A = parseVersion(a), B = parseVersion(b);
    for (let i = 0; i < 3; i++) {
      if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
    }
    return 0;
  }

  function isNewerVersion(remote, local) {
    return compareVersions(remote, local) > 0;
  }

  function formatTime(hhmm, hourFormat) {
    const mins = toMinutes(hhmm);
    let h = Math.floor(mins / 60), m = mins % 60;
    if (hourFormat === 24) return pad(h) + ":" + pad(m);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + pad(m) + " " + ap;
  }

  function daysFor(rem) {
    if (rem.repeat === "daily") return [0, 1, 2, 3, 4, 5, 6];
    if (rem.repeat === "weekdays") return [1, 2, 3, 4, 5];
    if (rem.repeat === "weekly" || rem.repeat === "custom") return rem.days && rem.days.length ? rem.days : [new Date().getDay()];
    return null; // once
  }

  function isActiveDay(rem, date) {
    const days = daysFor(rem);
    if (days) return days.includes(date.getDay());
    return true; // once: always eligible on its day
  }

  /* The moment the reminder is due today (or the active snooze time).
     May be in the past; the app decides how late it is still worth alerting. */
  function dueMoment(rem, now) {
    now = now || new Date();
    if (!rem || rem.enabled === false) return null;
    if (rem.repeat === "once" && rem.completed) return null;
    if (rem.snoozedUntil && +rem.snoozedUntil > 0) return new Date(+rem.snoozedUntil);
    if (!isActiveDay(rem, now)) return null;
    if (rem.lastCompletedDate === todayKey(now)) return null;
    if (rem.repeat === "once" && rem.at) return new Date(+rem.at);
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(toMinutes(rem.time));
    return d;
  }

  /* Next fire Date for a reminder after `from`. Null if none (e.g. completed once). */
  function nextOccurrence(rem, from) {
    from = from || new Date();
    if (!rem || rem.enabled === false) return null;
    if (rem.repeat === "once" && rem.completed) return null;
    // A snoozed reminder always fires at its snooze time, whatever its schedule.
    if (rem.snoozedUntil && +rem.snoozedUntil > from.getTime()) return new Date(+rem.snoozedUntil);
    const mins = toMinutes(rem.time);
    if (rem.repeat === "once") {
      if (rem.completed) return null;
      // Quick one-off timers carry an exact epoch time. A past one-off is
      // missed (the app catches up only within a short window), never "next".
      if (rem.at) {
        const t = +rem.at;
        return t > from.getTime() ? new Date(t) : null;
      }
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      d.setMinutes(mins);
      if (d.getTime() <= from.getTime()) {
        // Its time already passed and it never fired: run it at the same time
        // tomorrow rather than surprising the user with an instant alert.
        if (rem.lastFiredAt) return null;
        d.setDate(d.getDate() + 1);
      }
      return d;
    }
    for (let i = 0; i < 8; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      d.setMinutes(mins);
      if (d.getTime() <= from.getTime()) continue;
      if (daysFor(rem).includes(d.getDay())) {
        if (rem.lastCompletedDate === todayKey(d)) continue;
        return d;
      }
    }
    return null;
  }

  /* The time shown for today's occurrence. A snooze moves the visible time;
     a quick one-off uses its exact at-time rather than the rounded minute. */
  function displayTime(rem, now) {
    now = now || new Date();
    if (!rem) return "09:00";
    if (rem.snoozedUntil && +rem.snoozedUntil > now.getTime()) {
      const sn = new Date(+rem.snoozedUntil);
      if (todayKey(sn) === todayKey(now)) return fromMinutes(sn.getHours() * 60 + sn.getMinutes());
    }
    if (rem.repeat === "once" && rem.at) {
      const d = new Date(+rem.at);
      if (!isNaN(d.getTime()) && todayKey(d) === todayKey(now)) {
        return fromMinutes(d.getHours() * 60 + d.getMinutes());
      }
    }
    return rem.time || "09:00";
  }

  /* Status of a reminder occurrence today. */
  function todayStatus(rem, now) {
    now = now || new Date();
    if (!rem || rem.enabled === false) return "off";
    const key = todayKey(now);
    if (rem.lastCompletedDate === key || (rem.repeat === "once" && rem.completed)) return "done";
    if (!isActiveDay(rem, now)) return "off";
    // One-off timers belong to the day they were actually scheduled for.
    if (rem.repeat === "once" && rem.at && todayKey(new Date(+rem.at)) !== key) return "off";
    const mins = toMinutes(displayTime(rem, now));
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const diff = mins - nowMins;
    if (diff >= 0 && diff <= 5) return "now";
    if (diff > 5) return "upcoming";
    if (diff > -15) return "now";
    return "missed";
  }

  function sortByTime(a, b) { return toMinutes(a.time) - toMinutes(b.time); }

  /* Do Not Disturb: true while reminders are paused. */
  function isPaused(settings) {
    return !!(settings && settings.pausedUntil && +settings.pausedUntil > Date.now());
  }

  /* Short, human-friendly duration for countdowns, e.g. "42 min". */
  function humanizeDuration(ms) {
    const total = Math.max(0, Math.round((+ms || 0) / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return "less than a minute";
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor((+ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  /* Stopwatch string with centisecond precision: M:SS.cc, or H:MM:SS.cc once
     the run passes an hour. Hundredths are the finest precision a stopwatch
     can show at 60 fps without the digits blurring into noise. */
  function formatStopwatch(ms) {
    ms = Math.max(0, +ms || 0);
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const centis = Math.floor((ms % 1000) / 10);
    const tail = pad(s) + "." + pad(centis);
    if (h > 0) return h + ":" + pad(m) + ":" + tail;
    return m + ":" + tail;
  }

  /* Compact screen-time label, e.g. "2h 14m" / "18m" / "<1m". */
  function formatScreenTime(ms) {
    const mins = Math.floor(Math.max(0, +ms || 0) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return "<1m";
  }

  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /* ---- voice helpers (single source of truth for speech) ---- */

  const VOICE_RATES = {
    // 1.0 is the engine's natural speed. Slowing a good male voice down (the
    // old 0.92) made it sound sluggish and muffled, so normal now speaks at
    // its intended pace.
    male:    { slow: 0.78, normal: 1.0, fast: 1.16 },
    female:  { slow: 0.68, normal: 0.92, fast: 1.08 },
    default: { slow: 0.72, normal: 0.98, fast: 1.1 },
  };
  function voiceRate(speed, gender) {
    const table = VOICE_RATES[gender] || VOICE_RATES.default;
    return table[speed] || table.normal;
  }
  function voicePitch(gender) {
    // Kept for compatibility; a real voice is never pitch-shifted.
    return 1.0;
  }
  function ttsLang(lang) {
    if (!lang || lang === "system") return undefined;
    if (lang === "en") return "en-US";
    return lang;
  }

  const VOICE_GENDER_HINTS = {
    female: ["female", "zira", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "veena", "aditi", "ava", "susan", "kate", "emily", "serena", "heera", "lekha", "aria", "jenny", "hazel", "allison", "eva", "paulina", "amelie", "denise", "joanna", "kimberly", "salli", "amy", "raveena", "priya", "kalpana", "neerja", "zhiyu", "huihui", "yaoyao",
      "google uk english female", "sonia", "anais", "marisol", "lucia", "camila", "valentina", "sofia", "isabella", "gabriela", "mia", "ella", "olivia",
      "zoe", "nicky", "martha"],
    male: ["male", "david", "daniel", "mark", "alex", "fred", "thomas", "rishi", "ravi", "hemant", "george", "james", "roger", "ryan", "davis", "christopher", "brian", "neil", "arthur", "arun", "madhur", "valluvar", "jian", "kangkang", "yunyang",
      "google uk english male", "guy", "steffan", "antonio", "diego", "jorge", "liam", "tony", "henry", "mike", "tom", "bob",
      "aaron", "adam", "gordon", "oliver", "maged", "tarik", "yuri", "dmitri", "pavel"],
  };
  function detectVoiceGender(name) {
    const n = String(name || "").toLowerCase();
    if (!n) return null;
    if (n.indexOf("female") >= 0) return "female";
    const hasF = VOICE_GENDER_HINTS.female.some((h) => n.indexOf(h) >= 0);
    const hasM = VOICE_GENDER_HINTS.male.some((h) => n.indexOf(h) >= 0)
      || (n.indexOf("male") >= 0 && n.indexOf("female") < 0);
    if (hasF && !hasM) return "female";
    if (hasM && !hasF) return "male";
    return null;
  }

  /* Normalize text before speaking so English is pronounced clearly and naturally.
     Only the spoken copy is changed — the stored reminder text is untouched. */
  function normalizeSpeechText(text) {
    let t = String(text == null ? "" : text);
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, ""); // emojis -> silence
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/&/g, " and ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/([.!?])([A-Za-z])/g, "$1 $2");
    t = t.replace(/\s+([,.!?;:])/g, "$1");
    if (t && !/[.!?…]$/.test(t)) t += ".";
    return t;
  }

  return {
    APP, CATEGORIES, CATEGORY_MAP, DEFAULT_SETTINGS, DEFAULT_OFFICE, DEFAULT_SCHEDULE,
    REPEATS, SOUNDS, SOUND_NAMES, SETTINGS_SOUND_NAMES,
    uid, safeId, pad, clampNum, toMinutes, fromMinutes, todayKey, formatTime,
    parseVersion, compareVersions, isNewerVersion,
    normalizeReminder, normalizeSettings, normalizeOffice, normalizeScreen, normalizeStopwatch,
    daysFor, isActiveDay, dueMoment, nextOccurrence, todayStatus, displayTime, sortByTime,
    WEEKDAYS, WEEKDAYS_SHORT, isPaused, humanizeDuration,
    formatClock, formatStopwatch, formatScreenTime,
    voiceRate, voicePitch, ttsLang, normalizeSpeechText, detectVoiceGender,
  };
});
