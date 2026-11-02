/* Work Reminder — mobile app controller.
   - local-first storage (localStorage)
   - foreground alarm engine with catch-up after the phone wakes
   - service-worker notifications with Done / Snooze actions
   - WebAudio chimes + Web Speech voice
   - PWA install, haptics, wake lock, screen time and stopwatch */
(function () {
  "use strict";

  const WR = window.WR;
  const Sound = window.SoundEngine;
  const Voice = window.VoiceEngine;
  const APP = WR.APP;
  const CAT = WR.CATEGORY_MAP;
  const STORE_KEY = APP.storageKey;
  const VIEWS = ["home", "schedule", "focus", "settings"];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAY_SHORT = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
  const DAY_FULL = { 0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday" };
  const QUICK_MINUTES = [5, 10, 15, 30, 60];
  const CATCHUP_MS = 10 * 60 * 1000;
  const VERSION_KEY = "workreminderapp:last-version";
  const UPDATE_INFO_KEY = "workreminderapp:update-info";
  const UPDATE_NOTIFIED_KEY = "workreminderapp:update-notified";
  const UPDATE_DISMISSED_KEY = "workreminderapp:update-dismissed";
  const UPDATE_CHECK_MS = 30 * 60 * 1000;
  const UPDATE_RECHECK_MS = 5 * 60 * 1000;
  const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, lo, hi, fb) => {
    const n = Number(v);
    if (!isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };

  let state = null;
  let firstRun = false;
  let view = "home";
  let quickMinutes = 10;
  let filterCategory = "all";
  let searchTerm = "";
  let currentNext = null;
  let editingId = null;
  let formCategory = "work";
  let formDays = new Set([1, 2, 3, 4, 5]);
  let officeDays = new Set([1, 2, 3, 4, 5]);
  let deferredPrompt = null;
  let swReg = null;
  let confirmResolve = null;
  let activeAlert = null;
  let alertTimer = 0;
  let toastTimer = 0;
  let wakeSentinel = null;
  let lastMinute = -1;
  let lastDay = "";
  let checking = false;
  let suggestions = [];
  let screenSaveTimer = 0;
  let swFrame = 0;                // requestAnimationFrame handle for the stopwatch
  let swPerfStart = 0;            // performance.now() base for the current run
  let updateInfo = null;          // a newer version offered by version.json
  let whatsNewInfo = null;        // release notes for the running version
  let updateChecking = false;
  let updateApplying = false;
  let updateMessage = "";
  let updateMessageError = false;
  let dismissedUpdate = (() => {
    try { return localStorage.getItem(UPDATE_DISMISSED_KEY) || ""; } catch (e) { return ""; }
  })();
  let lastUpdateCheck = 0;
  let lastCheckFailed = false;
  let reloadAfterUpdate = false;

  /* ---------------- storage ---------------- */

  function defaultReminders() {
    return WR.DEFAULT_SCHEDULE.map(([time, title, category, message]) => WR.normalizeReminder({
      id: WR.uid(), time, title, category, message,
      repeat: "weekdays", days: [1, 2, 3, 4, 5],
      enabled: true, notificationEnabled: true, voiceEnabled: true,
      sound: "default", createdAt: Date.now(), updatedAt: Date.now(),
    }));
  }

  function loadState() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch (e) {
      raw = null;
    }
    const src = (raw && typeof raw === "object") ? raw : {};
    const reminders = Array.isArray(src.reminders)
      ? src.reminders.map((r, i) => WR.normalizeReminder(r, "r_mig_" + i)).slice(0, 1000)
      : [];
    const seeded = src.seeded === true;
    firstRun = !seeded && reminders.length === 0;

    state = {
      settings: WR.normalizeSettings(src.settings),
      office: WR.normalizeOffice(src.office),
      reminders: (firstRun ? defaultReminders() : reminders),
      screen: WR.normalizeScreen(src.screen),
      stopwatch: WR.normalizeStopwatch(src.stopwatch),
      seeded: true,
      installedAt: isFinite(+src.installedAt) && +src.installedAt > 0 ? +src.installedAt : Date.now(),
      updatedAt: Date.now(),
    };
    // Turn any time the stopwatch ran before this load into accumulated time and
    // anchor the live run to performance.now(), so wall-clock changes cannot
    // make the counter jump or run backwards.
    if (state.stopwatch.running) {
      const now = Date.now();
      if (state.stopwatch.startedAt > 0 && now > state.stopwatch.startedAt) {
        state.stopwatch.accumulated += now - state.stopwatch.startedAt;
      }
      state.stopwatch.startedAt = now;
      swPerfStart = typeof performance !== "undefined" ? performance.now() : 0;
    }

    officeDays = new Set(state.office.days);
    if (firstRun) save();
  }

  function save() {
    if (!state) return true;
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast("Storage is full — could not save.", true);
      return false;
    }
  }

  function saveSoon() {
    if (screenSaveTimer) return;
    screenSaveTimer = setTimeout(() => {
      screenSaveTimer = 0;
      save();
    }, 1200);
  }

  /* ---------------- small UI helpers ---------------- */

  function toast(msg, isError) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
  }

  function setHelper(id, msg, isError) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  function openSheet(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("sheet-open");
    const first = el.querySelector("button, input, select, textarea");
    if (first) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) {} }, 60);
  }

  function closeSheet(id) {
    const el = $(id);
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".sheet-wrap:not(.hidden)")) {
      document.body.classList.remove("sheet-open");
    }
  }

  function askConfirm(title, text, okLabel) {
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOk").textContent = okLabel || "Confirm";
    openSheet("confirmSheet");
    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  function settleConfirm(value) {
    closeSheet("confirmSheet");
    const fn = confirmResolve;
    confirmResolve = null;
    if (fn) fn(value);
  }

  function haptic(pattern) {
    if (!state || !state.settings.haptics) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 30);
    } catch (e) {}
  }

  function applyTheme() {
    const pref = state ? state.settings.theme : "dark";
    const dark = pref === "dark" || (pref === "system" &&
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#070b16" : "#eef3fd");
  }

  function isPaused() {
    return WR.isPaused(state && state.settings);
  }

  function hasNotifications() {
    return typeof Notification !== "undefined" && Notification.permission === "granted";
  }

  function notificationState() {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  }

  /* ---------------- navigation ---------------- */

  function showView(name) {
    if (!VIEWS.includes(name)) name = "home";
    view = name;
    $$(".view").forEach((el) => el.classList.toggle("active", el.dataset.view === name));
    $$(".tab").forEach((el) => el.classList.toggle("active", el.dataset.view === name));
    window.scrollTo({ top: 0, behavior: "auto" });
    if (name === "focus") {
      renderFocus();
      startStopwatchLoop();
    } else {
      stopStopwatchLoop();
    }
    if (name === "settings") renderSettings();
    if (name === "schedule") renderSchedule();
    if (name === "home") renderHome();
  }

  /* ---------------- formatting helpers ---------------- */

  function fmtTime(hhmm) {
    return WR.formatTime(hhmm, state.settings.hourFormat);
  }

  function dayLabel(rem) {
    if (rem.repeat === "daily") return "Every day";
    if (rem.repeat === "weekdays") return "Weekdays";
    if (rem.repeat === "once") {
      if (rem.at) {
        const d = new Date(+rem.at);
        if (!isNaN(d.getTime())) return "Once · " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      }
      return "Once";
    }
    return rem.days.map((d) => DAY_SHORT[d]).join(", ") || "Custom";
  }

  function categoryOf(rem) {
    return CAT[rem.category] || CAT.custom;
  }

  function relativeCountdown(target) {
    return "in " + WR.humanizeDuration(target.getTime() - Date.now());
  }

  function greeting(now) {
    const h = now.getHours();
    if (h < 5) return "Good night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  /* ---------------- rendering ---------------- */

  function occursToday(rem, now) {
    if (!rem.enabled) return false;
    if (rem.snoozedUntil && WR.todayKey(new Date(rem.snoozedUntil)) === WR.todayKey(now)) return true;
    if (rem.repeat === "once") {
      if (rem.at) return WR.todayKey(new Date(+rem.at)) === WR.todayKey(now);
      return true;
    }
    return WR.isActiveDay(rem, now);
  }

  function todayReminders(now) {
    now = now || new Date();
    return state.reminders
      .filter((r) => occursToday(r, now))
      .sort((a, b) => WR.toMinutes(WR.displayTime(a, now)) - WR.toMinutes(WR.displayTime(b, now)));
  }

  function upcomingList(now) {
    now = now || new Date();
    return state.reminders
      .map((r) => ({ r, next: WR.nextOccurrence(r, now) }))
      .filter((x) => x.next)
      .sort((a, b) => a.next - b.next);
  }

  function renderHome() {
    if (!state) return;
    const now = new Date();
    $("greeting").textContent = greeting(now);
    $("todayDate").textContent = now.toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });

    const todays = todayReminders(now);
    $("todayCount").textContent = todays.length + (todays.length === 1 ? " item" : " items");
    $("homeBadge").textContent = isPaused() ? "Paused" : todays.length + " today";

    renderNext(now);
    renderQuick();
    renderToday(todays, now);
    renderHomeStats(now);
    updateHeader();
  }

  function renderNext(now) {
    const up = upcomingList(now);
    currentNext = up.length ? up[0].r : null;
    const actions = $("nextActions");
    const meta = $("nextMeta");

    if (!up.length) {
      $("nextTime").textContent = "--:--";
      $("nextCountdown").textContent = "No reminders yet";
      $("nextTitle").textContent = "Nothing scheduled";
      $("nextMessage").textContent = "Add your first reminder to get started.";
      $("nextWhen").textContent = "—";
      $("nextDot").style.background = "transparent";
      meta.innerHTML = "";
      actions.classList.add("hidden");
      return;
    }

    const { r, next } = up[0];
    const snoozed = !!(r.snoozedUntil && r.snoozedUntil > Date.now());
    const cat = categoryOf(r);
    $("nextTime").textContent = fmtTime(WR.displayTime(r, now));
    $("nextCountdown").textContent = (snoozed ? "snoozed · " : "") + relativeCountdown(next);
    $("nextTitle").textContent = r.title;
    $("nextMessage").textContent = r.message || "No message — the title will be spoken.";
    $("nextWhen").textContent = WR.todayKey(next) === WR.todayKey(now)
      ? "Today"
      : next.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("nextDot").style.background = cat.color;
    actions.classList.remove("hidden");

    const bits = [];
    bits.push('<span class="chip" style="--cat:' + cat.color + '"><i style="width:7px;height:7px;border-radius:50%;background:' + cat.color + '"></i>' + cat.label + "</span>");
    bits.push('<span class="chip">' + dayLabel(r) + "</span>");
    if (r.sound && r.sound !== "none") bits.push('<span class="chip">' + (WR.SOUNDS.find((s) => s.id === r.sound) || {}).label + "</span>");
    if (r.voiceEnabled && state.settings.voiceEnabled) bits.push('<span class="chip">Voice</span>');
    if (isPaused()) bits.push('<span class="chip" style="color:var(--warn)">Paused</span>');
    meta.innerHTML = bits.join("");
  }

  function renderQuick() {
    const wrap = $("quickChips");
    if (!wrap || wrap.children.length) return;
    wrap.innerHTML = QUICK_MINUTES.map((m) =>
      '<button class="chip-btn' + (m === quickMinutes ? " on" : "") + '" type="button" data-quick="' + m + '">' +
      (m < 60 ? m + " min" : "1 hour") + "</button>").join("");
  }

  function renderToday(list, now) {
    const ul = $("todayList");
    const empty = $("todayEmpty");
    ul.innerHTML = "";
    empty.classList.toggle("hidden", list.length > 0);
    $("todayProgress").style.width = list.length
      ? Math.round((list.filter((r) => WR.todayStatus(r, now) === "done").length / list.length) * 100) + "%"
      : "0%";

    for (const r of list) {
      const cat = categoryOf(r);
      const status = WR.todayStatus(r, now);
      const li = document.createElement("li");
      li.className = status;
      li.style.setProperty("--cat", cat.color);
      li.dataset.id = r.id;
      li.innerHTML =
        '<span class="t">' + fmtTime(WR.displayTime(r, now)) + "<small>" + (status === "done" ? "DONE" : status === "now" ? "NOW" : status === "missed" ? "MISSED" : "TODAY") + "</small></span>" +
        '<span class="dot" aria-hidden="true"></span>' +
        '<div class="row-main"><b>' + escapeHtml(r.title) + "</b><span>" + escapeHtml(cat.label) + (r.message ? " · " + escapeHtml(r.message).slice(0, 46) : "") + "</span></div>" +
        '<button class="tick' + (status === "done" ? " on" : "") + '" type="button" data-tick="' + r.id + '" aria-label="' + (status === "done" ? "Mark not done" : "Mark done") + '">' +
        '<svg class="ic" aria-hidden="true"><use href="#i-check"></use></svg></button>';
      ul.appendChild(li);
    }
  }

  function renderHomeStats(now) {
    $("screenTimeHome").textContent = WR.formatScreenTime(screenMsToday(now));
    const wd = workdayInfo(now);
    $("workdayHomeLabel").textContent = "Workday";
    $("workdayHome").textContent = wd.home;
  }

  function screenMsToday(now) {
    now = now || new Date();
    return state.screen.day === WR.todayKey(now) ? state.screen.ms : 0;
  }

  function workdayInfo(now) {
    const o = state.office;
    const key = WR.todayKey(now);
    const active = o.days.includes(now.getDay());
    const nowM = now.getHours() * 60 + now.getMinutes();
    const startM = WR.toMinutes(o.start);
    const endM = WR.toMinutes(o.end);
    const total = Math.max(1, endM - startM);
    if (!active) return { active: false, home: "—", pct: 0, note: "Not a working day", left: "—", label: "Workday" };

    if (nowM < startM) {
      return {
        active: true, home: WR.humanizeDuration((startM - nowM) * 60000),
        pct: 0, left: "Starts " + fmtTime(o.start),
        note: "Office hours start at " + fmtTime(o.start) + ".", label: "Until work",
      };
    }
    if (nowM >= endM) {
      return {
        active: true, home: "Done", pct: 100, left: "0m",
        note: "Office hours are over for today.", label: "Workday", done: true,
      };
    }
    const leftMin = endM - nowM;
    return {
      active: true,
      home: WR.humanizeDuration(leftMin * 60000) + " left",
      pct: Math.round(((nowM - startM) / total) * 100),
      left: WR.humanizeDuration(leftMin * 60000),
      note: "Office hours end at " + fmtTime(o.end) + " · day " + key.slice(5),
      label: "Workday left",
    };
  }

  function updateHeader() {
    const paused = isPaused();
    $("dndDot").classList.toggle("hidden", !paused);
    const perm = notificationState();
    $("alertsDot").classList.toggle("hidden", perm === "granted");
    $("headerSub").textContent = paused
      ? "Do Not Disturb until " + new Date(state.settings.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "Office " + fmtTime(state.office.start) + " – " + fmtTime(state.office.end);
    $("appVersionChip").textContent = "v" + APP.version;
    $("aboutVersion").textContent = "v" + APP.version + " · mobile";
    renderUpdateUI();
    $("alertsStrip").classList.toggle("hidden", perm === "granted");
    $("installStrip").classList.toggle("hidden",
      window.matchMedia("(display-mode: standalone)").matches);
    $("voiceBadge").textContent = state.settings.voiceEnabled ? "On" : "Off";
    $("dndBadge").textContent = paused ? "On" : "Off";
    $("dndText").textContent = paused
      ? "Paused until " + new Date(state.settings.pausedUntil).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) + ". Sounds, voice and notifications are silenced."
      : "Silence every reminder, sound and voice.";
  }

  /* ---------------- schedule view ---------------- */

  function renderSchedule() {
    if (!state) return;
    renderFilters();
    renderOfficeSummary();
    renderReminderList();
    updateHeader();
  }

  function renderFilters() {
    const wrap = $("filterChips");
    if (!wrap) return;
    const counts = { all: state.reminders.length };
    for (const c of WR.CATEGORIES) counts[c.id] = state.reminders.filter((r) => r.category === c.id).length;
    const chips = [{ id: "all", label: "All" }].concat(WR.CATEGORIES);
    wrap.innerHTML = chips.map((c) =>
      '<button class="chip-btn' + (filterCategory === c.id ? " on" : "") + '" type="button" data-filter="' + c.id + '">' +
      c.label + ' <span style="opacity:.62">' + (counts[c.id] || 0) + "</span></button>").join("");
  }

  function renderReminderList() {
    const ul = $("reminderList");
    const empty = $("reminderEmpty");
    if (!ul) return;
    const term = searchTerm.trim().toLowerCase();
    const list = state.reminders
      .filter((r) => filterCategory === "all" || r.category === filterCategory)
      .filter((r) => !term || (r.title + " " + r.message).toLowerCase().includes(term))
      .sort((a, b) => WR.toMinutes(a.time) - WR.toMinutes(b.time));

    ul.innerHTML = "";
    empty.classList.toggle("hidden", list.length > 0);
    setHelper("scheduleStatus", list.length
      ? list.length + " reminder" + (list.length === 1 ? "" : "s") + (term ? " matching “" + searchTerm.trim() + "”" : "")
      : "");

    for (const r of list) {
      const cat = categoryOf(r);
      const li = document.createElement("li");
      li.className = "reminder-item" + (r.enabled ? "" : " off");
      li.dataset.open = r.id;
      li.style.setProperty("--cat", cat.color);
      li.innerHTML =
        '<span class="reminder-time">' + fmtTime(r.time) + "<small>" + (r.repeat === "once" ? "ONCE" : dayLabel(r).toUpperCase()) + "</small></span>" +
        '<div class="reminder-main"><b>' + escapeHtml(r.title) + "</b>" +
        '<span class="sub"><span class="cat-pill" style="--cat:' + cat.color + '"><i></i>' + cat.label + "</span>" +
        (r.message ? escapeHtml(r.message) : "No message") + "</span></div>" +
        '<label class="switch" aria-label="Toggle ' + escapeAttr(r.title) + '"><input type="checkbox" data-toggle="' + r.id + '"' + (r.enabled ? " checked" : "") + "><span></span></label>";
      ul.appendChild(li);
    }
  }

  function renderOfficeSummary() {
    const box = $("officeSummary");
    if (!box) return;
    const o = state.office;
    const mins = (a, b) => {
      let d = WR.toMinutes(b) - WR.toMinutes(a);
      if (d < 0) d += 1440;
      return d;
    };
    const hours = (mins(o.start, o.end) / 60).toFixed(1).replace(/\.0$/, "");
    const days = DAY_ORDER.map((d) => '<i class="' + (o.days.includes(d) ? "on" : "") + '">' + DAY_SHORT[d].slice(0, 2) + "</i>").join("");
    box.innerHTML =
      '<div class="kv"><span>Start</span><b>' + fmtTime(o.start) + "</b></div>" +
      '<div class="kv"><span>End</span><b>' + fmtTime(o.end) + "</b></div>" +
      '<div class="kv"><span>Lunch</span><b>' + fmtTime(o.lunchStart) + " – " + fmtTime(o.lunchEnd) + "</b></div>" +
      '<div class="kv"><span>Day length</span><b>' + hours + " h</b></div>" +
      '<div class="kv"><span>Days</span><span class="office-day-dots">' + days + "</span></div>";
  }

  /* ---------------- focus view ---------------- */

  function renderFocus() {
    if (!state) return;
    const now = new Date();
    $("clockTime").textContent = now.toLocaleTimeString([], { hour12: state.settings.hourFormat !== 24, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("clockDate").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    try {
      $("clockZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop().replace(/_/g, " ");
    } catch (e) {
      $("clockZone").textContent = "local";
    }
    $("screenTime").textContent = WR.formatScreenTime(screenMsToday(now));
    const wd = workdayInfo(now);
    $("workdayLabel").textContent = wd.label;
    $("workdayLeft").textContent = wd.left;
    $("workdayBar").style.width = Math.max(0, Math.min(100, wd.pct)) + "%";
    $("workdayNote").textContent = wd.note;

    const sw = state.stopwatch;
    paintStopwatch(true);
    $("swState").textContent = sw.running ? "Running" : (swElapsed() > 0 ? "Paused" : "Idle");
    $("swToggle").textContent = sw.running ? "Pause" : (swElapsed() > 0 ? "Resume" : "Start");
    $("swLap").disabled = !sw.running;
    $("wakeToggle").checked = state.settings.keepAwake;
    renderLaps();
    if (sw.running && view === "focus") startStopwatchLoop();
    else stopStopwatchLoop();
  }

  function swElapsed() {
    const sw = state.stopwatch;
    const accumulated = Math.max(0, +sw.accumulated || 0);
    if (!sw.running) return accumulated;
    // performance.now() is monotonic and sub-millisecond; Date.now() remains
    // the fallback (and the persisted clock) when the page has just loaded.
    const live = swPerfStart && typeof performance !== "undefined"
      ? performance.now() - swPerfStart
      : Date.now() - (+sw.startedAt || Date.now());
    return Math.max(0, accumulated + live);
  }

  /* Repaint the stopwatch at animation-frame speed. Only the hundredths span
     changes every frame; the stable minutes/seconds are left untouched, and
     the text is only written when a rendered value actually changes. */
  function paintStopwatch(force) {
    const text = WR.formatStopwatch(swElapsed());
    const main = $("swMain");
    const frac = $("swFrac");
    if (!main || !frac) {
      // Fallback for a stale cached document without the split markup.
      const el = $("swTime");
      if (el && (force || el.textContent !== text)) el.textContent = text;
      return;
    }
    const dot = text.lastIndexOf(".");
    const head = text.slice(0, dot);
    const tail = text.slice(dot);
    if (force || main.textContent !== head) main.textContent = head;
    if (force || frac.textContent !== tail) frac.textContent = tail;
  }

  /* Re-anchor the live run to the wall clock. Browsers can suspend
     performance.now() while the page or device sleeps, so on return (and on
     boot) fold the wall-clock gap into accumulated time. */
  function rebaseStopwatch() {
    const sw = state && state.stopwatch;
    if (!sw || !sw.running) return;
    const now = Date.now();
    if (sw.startedAt > 0 && now > sw.startedAt) sw.accumulated += now - sw.startedAt;
    sw.startedAt = now;
    swPerfStart = typeof performance !== "undefined" ? performance.now() : 0;
  }

  function startStopwatchLoop() {
    if (swFrame) return;
    if (!state || !state.stopwatch.running || document.visibilityState === "hidden") {
      paintStopwatch();
      return;
    }
    const step = () => {
      swFrame = 0;
      if (!state || !state.stopwatch.running || view !== "focus") {
        paintStopwatch();
        return;
      }
      paintStopwatch();
      swFrame = requestAnimationFrame(step);
    };
    swFrame = requestAnimationFrame(step);
  }

  function stopStopwatchLoop() {
    if (swFrame) cancelAnimationFrame(swFrame);
    swFrame = 0;
  }

  function renderLaps() {
    const ul = $("swLaps");
    if (!ul) return;
    const laps = state.stopwatch.laps || [];
    ul.innerHTML = laps.map((ms, i) =>
      "<li><b>Lap " + (i + 1) + "</b><span>" + WR.formatStopwatch(ms) + "</span>" +
      '<span class="sw-total">' + WR.formatStopwatch(laps.slice(0, i + 1).reduce((a, b) => a + b, 0)) + "</span></li>").join("");
  }

  /* ---------------- settings view ---------------- */

  function fillSelect(el, items, value) {
    if (!el) return;
    el.innerHTML = items.map((it) => '<option value="' + it.value + '">' + it.label + "</option>").join("");
    el.value = value;
  }

  function renderSettings() {
    if (!state) return;
    const s = state.settings;

    const perm = notificationState();
    const badge = $("permBadge");
    const btn = $("enableAlertsBtn2");
    if (perm === "granted") {
      badge.textContent = "On";
      badge.className = "chip";
      $("permText").textContent = "Notifications are allowed. Reminders alert even when the app is in the background (where the browser allows it).";
      btn.textContent = "Send a test notification";
    } else if (perm === "denied") {
      badge.textContent = "Blocked";
      badge.className = "chip";
      $("permText").textContent = "Notifications are blocked. Open your browser's site settings for this app and allow notifications.";
      btn.textContent = "How to unblock";
    } else if (perm === "unsupported") {
      badge.textContent = "Limited";
      badge.className = "chip";
      $("permText").textContent = "This browser has no notification API. In-app alerts and sounds still work while the app is open.";
      btn.textContent = "Sound & in-app alerts only";
    } else {
      badge.textContent = "Off";
      badge.className = "chip";
      $("permText").textContent = "Allow notifications so reminders can reach you when the screen is locked or another app is open.";
      btn.textContent = "Enable notifications";
    }
    $("notifToggle").checked = s.notificationsEnabled;
    $("voiceToggle").checked = s.voiceEnabled;
    $("hapticsToggle").checked = s.haptics;
    $("wakeToggle").checked = s.keepAwake;

    fillSelect($("soundSelect"), WR.SOUNDS.filter((x) => x.id !== "none").map((x) => ({ value: x.id, label: x.label + " — " + x.hint })), s.sound.name);
    $("soundVolume").value = s.sound.volume;
    $("soundVolLabel").textContent = s.sound.volume + "%";

    fillSelect($("voiceLang"), [
      { value: "en", label: "English" }, { value: "ne", label: "Nepali" },
      { value: "hi", label: "Hindi" }, { value: "system", label: "Device default" },
    ], s.voice.language);
    fillSelect($("voiceGender"), [
      { value: "default", label: "System default" }, { value: "female", label: "Female" },
      { value: "male", label: "Male" },
    ], s.voice.gender);
    fillSelect($("voiceSpeed"), [
      { value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" },
    ], s.voice.speed);
    $("voiceVolume").value = s.voice.volume;
    $("voiceVolLabel").textContent = s.voice.volume + "%";
    fillSelect($("snoozeSelect"), [5, 10, 15, 30].map((m) => ({ value: String(m), label: m + " min" })), String(s.defaultSnooze));

    $$("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === s.theme));
    $$("#hourSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.hour === s.hourFormat));
    $("themeSeg").setAttribute("aria-label", "Theme");

    $("offStart").value = state.office.start;
    $("offEnd").value = state.office.end;
    $("offLunchStart").value = state.office.lunchStart;
    $("offLunchEnd").value = state.office.lunchEnd;
    renderOfficeDays();

    $("installNote").textContent = window.matchMedia("(display-mode: standalone)").matches
      ? "Already installed — you are running the home-screen app."
      : IOS
        ? "On iPhone or iPad: tap the Share button in Safari, then “Add to Home Screen”."
        : "Install Work Reminder on your home screen for full-screen access and faster alerts.";
    $("installBtn").disabled = window.matchMedia("(display-mode: standalone)").matches;
    $("repoLink").href = APP.repoUrl;
    $("devLink").href = APP.devUrl;
    updateHeader();
  }

  function renderOfficeDays() {
    const wrap = $("offDays");
    if (!wrap) return;
    wrap.innerHTML = DAY_ORDER.map((d) =>
      '<button type="button" class="day-chip' + (officeDays.has(d) ? " on" : "") + '" data-office-day="' + d + '">' + DAY_SHORT[d] + "</button>").join("");
  }

  function renderAll() {
    if (!state) return;
    applyTheme();
    renderHome();
    renderSchedule();
    renderFocus();
    renderSettings();
    renderUpdateUI();
  }

  /* ---------------- escaping ---------------- */

  function escapeHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(v) { return escapeHtml(v).replace(/"/g, "&quot;"); }

  /* ---------------- reminder actions ---------------- */

  function findReminder(id) {
    return state.reminders.find((r) => r.id === id) || null;
  }

  function markDone(id) {
    const r = findReminder(id);
    if (!r) return;
    const now = new Date();
    if (r.repeat === "once") {
      r.completed = true;
      r.snoozedUntil = 0;
    } else {
      r.lastCompletedDate = WR.todayKey(now);
      r.snoozedUntil = 0;
    }
    r.updatedAt = Date.now();
    if (activeAlert && activeAlert.id === id) dismissAlert();
    save();
    renderAll();
    haptic(24);
    toast("“" + r.title + "” marked done.");
  }

  function unmarkDone(id) {
    const r = findReminder(id);
    if (!r) return;
    if (r.repeat === "once") r.completed = false;
    r.lastCompletedDate = null;
    r.updatedAt = Date.now();
    save();
    renderAll();
  }

  function toggleDone(id) {
    const r = findReminder(id);
    if (!r) return;
    if (r.repeat === "once" ? r.completed : r.lastCompletedDate === WR.todayKey()) unmarkDone(id);
    else markDone(id);
  }

  function snoozeReminder(id, minutes) {
    const r = findReminder(id);
    if (!r) return;
    r.snoozedUntil = Date.now() + Math.max(1, minutes) * 60000;
    r.updatedAt = Date.now();
    if (activeAlert && activeAlert.id === id) dismissAlert();
    save();
    renderAll();
    haptic(18);
    toast("Snoozed for " + minutes + " min.");
  }

  function toggleEnabled(id, enabled) {
    const r = findReminder(id);
    if (!r) return;
    r.enabled = !!enabled;
    r.updatedAt = Date.now();
    save();
    renderSchedule();
    renderHome();
    haptic(14);
  }

  /* ---------------- reminder sheet ---------------- */

  function buildCategoryPicker() {
    const wrap = $("fCategory");
    if (!wrap) return;
    wrap.innerHTML = WR.CATEGORIES.map((c) =>
      '<button type="button" class="cat-choice' + (c.id === formCategory ? " on" : "") + '" data-cat="' + c.id + '" style="--cat:' + c.color + '"><i></i>' + c.label + "</button>").join("");
  }

  function buildFormDays() {
    const wrap = $("fDays");
    if (!wrap) return;
    wrap.innerHTML = DAY_ORDER.map((d) =>
      '<button type="button" class="day-chip' + (formDays.has(d) ? " on" : "") + '" data-form-day="' + d + '">' + DAY_SHORT[d] + "</button>").join("");
  }

  function fillReminderSound(value) {
    fillSelect($("fSound"), WR.SOUNDS.map((s) => ({ value: s.id, label: s.label })), value || "default");
  }

  function openReminder(id) {
    if (!state) return;
    editingId = id || null;
    const r = id ? findReminder(id) : null;
    const sheet = $("reminderSheet");
    sheet.classList.toggle("editing", !!r);
    $("sheetTitle").textContent = r ? "Edit reminder" : "New reminder";
    $("fDelete").classList.toggle("hidden", !r);
    $("fDuplicate").classList.toggle("hidden", !r);
    $("fStatus").classList.add("hidden");
    $("fStatus").textContent = "";

    const now = new Date();
    const defaultTime = WR.fromMinutes(now.getHours() * 60 + now.getMinutes() + 30);
    $("fTime").value = r ? WR.displayTime(r, now) : defaultTime;
    $("fRepeat").value = r ? (r.repeat === "weekly" ? "custom" : r.repeat) : "weekdays";
    formDays = new Set(r && r.days && r.days.length ? r.days : [1, 2, 3, 4, 5]);
    formCategory = r ? r.category : "work";
    $("fTitle").value = r ? r.title : "";
    $("fMessage").value = r ? r.message : "";
    $("fVoice").checked = r ? r.voiceEnabled : true;
    $("fNotif").checked = r ? r.notificationEnabled : true;
    $("fEnabled").checked = r ? r.enabled : true;
    fillReminderSound(r ? r.sound : state.settings.sound.name);
    buildCategoryPicker();
    buildFormDays();
    toggleFormDays();

    $("fTime").closest(".field").classList.remove("hidden");
    openSheet("reminderSheet");
    setTimeout(() => { try { $("fTitle").focus({ preventScroll: true }); } catch (e) {} }, 220);
  }

  function closeReminder() {
    closeSheet("reminderSheet");
    editingId = null;
  }

  function toggleFormDays() {
    const show = $("fRepeat").value === "custom";
    $("fDaysWrap").classList.toggle("hidden", !show);
  }

  function saveReminder(ev) {
    if (ev) ev.preventDefault();
    const title = $("fTitle").value.replace(/\s+/g, " ").trim().slice(0, 160);
    const time = $("fTime").value;
    const repeat = $("fRepeat").value;
    const err = $("fStatus");

    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      err.textContent = "Choose a valid time.";
      err.classList.remove("hidden");
      return;
    }
    if (!title) {
      err.textContent = "Give the reminder a short title.";
      err.classList.remove("hidden");
      $("fTitle").focus();
      return;
    }
    if (repeat === "custom" && formDays.size === 0) {
      err.textContent = "Select at least one day.";
      err.classList.remove("hidden");
      return;
    }

    const existing = editingId ? findReminder(editingId) : null;
    const now = Date.now();
    const base = {
      id: existing ? existing.id : WR.uid(),
      title,
      message: $("fMessage").value.replace(/\s+/g, " ").trim().slice(0, 1000),
      time,
      category: formCategory,
      repeat,
      days: repeat === "custom" ? Array.from(formDays) : repeat === "weekdays" ? [1, 2, 3, 4, 5] : repeat === "daily" ? [0, 1, 2, 3, 4, 5, 6] : [],
      enabled: existing ? $("fEnabled").checked : true,
      completed: repeat === "once" ? (existing ? !!existing.completed : false) : false,
      notificationEnabled: $("fNotif").checked,
      voiceEnabled: $("fVoice").checked,
      sound: $("fSound").value,
      lastCompletedDate: existing ? existing.lastCompletedDate : null,
      lastFiredAt: existing ? existing.lastFiredAt : null,
      snoozedUntil: 0,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    if (repeat === "once") {
      const [h, m] = time.split(":").map(Number);
      let when = new Date();
      when.setSeconds(0, 0);
      when.setHours(h, m, 0, 0);
      if (existing && existing.at) {
        const prev = new Date(+existing.at);
        if (!isNaN(prev.getTime()) && prev.getTime() > now &&
          prev.getHours() === h && prev.getMinutes() === m) {
          when = prev;
        }
      }
      if (when.getTime() <= now) when.setDate(when.getDate() + 1);
      base.at = when.getTime();
      base.completed = false;
    }

    const norm = WR.normalizeReminder(base, existing ? existing.id : undefined);
    if (existing) {
      const i = state.reminders.findIndex((r) => r.id === existing.id);
      if (i >= 0) state.reminders[i] = norm;
    } else {
      state.reminders.push(norm);
    }
    if (!save()) {
      err.textContent = "Could not save — browser storage is full.";
      err.classList.remove("hidden");
      return;
    }
    closeReminder();
    renderAll();
    haptic(20);
    toast(existing ? "Reminder updated." : "Reminder added.");
  }

  async function deleteReminder() {
    const r = editingId ? findReminder(editingId) : null;
    if (!r) return;
    const ok = await askConfirm("Delete reminder?", "“" + r.title + "” will be removed from your schedule.", "Delete");
    if (!ok) return;
    state.reminders = state.reminders.filter((x) => x.id !== r.id);
    if (activeAlert && activeAlert.id === r.id) dismissAlert();
    save();
    closeReminder();
    renderAll();
    haptic([18, 40, 18]);
    toast("Reminder deleted.");
  }

  function duplicateReminder() {
    const r = editingId ? findReminder(editingId) : null;
    if (!r) return;
    const copy = WR.normalizeReminder(Object.assign({}, r, {
      id: WR.uid(), title: r.title + " (copy)", createdAt: Date.now(), updatedAt: Date.now(),
      lastCompletedDate: null, lastFiredAt: null, snoozedUntil: 0, completed: false,
    }));
    state.reminders.push(copy);
    save();
    closeReminder();
    renderAll();
    toast("Reminder duplicated.");
  }

  /* ---------------- quick reminder ---------------- */

  function addQuick() {
    if (!state) return;
    const text = $("quickText").value.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!text) {
      $("quickText").focus();
      setHelper("quickStatus", "Type what you need to remember first.", true);
      return;
    }
    const when = new Date(Date.now() + quickMinutes * 60000);
    when.setSeconds(0, 0);
    const rem = WR.normalizeReminder({
      id: WR.uid(),
      title: text,
      message: text,
      time: WR.fromMinutes(when.getHours() * 60 + when.getMinutes()),
      repeat: "once",
      at: when.getTime(),
      category: "custom",
      sound: state.settings.sound.name,
      voiceEnabled: state.settings.voiceEnabled,
      notificationEnabled: state.settings.notificationsEnabled,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    state.reminders.push(rem);
    save();
    $("quickText").value = "";
    setHelper("quickStatus", "Reminder set for " + fmtTime(rem.time) + " — " + WR.humanizeDuration(quickMinutes * 60000) + " from now.");
    haptic(20);
    renderAll();
    toast("Quick reminder added.");
  }

  /* ---------------- suggested schedule ---------------- */

  function buildSuggestions() {
    const o = state.office;
    const add = (mins, title, category, message) => ({
      time: WR.fromMinutes(mins), title, category, message,
      repeat: "weekdays", days: o.days.slice().sort(),
    });
    const startM = WR.toMinutes(o.start);
    const endM = WR.toMinutes(o.end);
    const lunchStartM = WR.toMinutes(o.lunchStart);
    const lunchEndM = WR.toMinutes(o.lunchEnd);
    const mid = Math.round((lunchEndM + endM) / 2);
    const list = [
      add(startM, "Start Work", "work", "Start work. Have a productive day!"),
      add(startM + 30, "Check Emails", "work", "Check your emails and plan the day."),
      add(startM + 120, "Take a Break", "break", "Take a short break. Rest your eyes."),
      add(lunchStartM, "Lunch Break", "break", "Time for lunch. Take a proper break!"),
      add(lunchEndM, "Continue Work", "work", "Back to work. Focus time!"),
      add(mid, "Drink Water", "personal", "Drink a glass of water."),
      add(Math.max(startM, endM - 30), "Review Tasks", "work", "Review your tasks before wrapping up."),
      add(endM, "Finish Work", "work", "Finish work. Great job today!"),
    ];
    const seen = new Set();
    return list.filter((s) => {
      const k = s.time + "|" + s.title;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => WR.toMinutes(a.time) - WR.toMinutes(b.time));
  }

  function openSuggestions() {
    suggestions = buildSuggestions();
    const ul = $("suggestList");
    ul.innerHTML = suggestions.map((s) => {
      const cat = CAT[s.category] || CAT.custom;
      return '<li style="--cat:' + cat.color + '"><span class="t">' + fmtTime(s.time) + "</span>" +
        '<div class="row-main"><b>' + escapeHtml(s.title) + "</b><span>" + escapeHtml(s.message) + "</span></div></li>";
    }).join("");
    openSheet("suggestSheet");
  }

  function addSuggestions() {
    if (!suggestions.length) return;
    for (const s of suggestions) {
      state.reminders.push(WR.normalizeReminder({
        id: WR.uid(), time: s.time, title: s.title, message: s.message,
        category: s.category, repeat: s.repeat, days: s.days,
        enabled: true, notificationEnabled: true, voiceEnabled: true,
        sound: state.settings.sound.name,
        createdAt: Date.now(), updatedAt: Date.now(),
      }));
    }
    save();
    closeSheet("suggestSheet");
    renderAll();
    haptic(20);
    toast(suggestions.length + " reminders added to your schedule.");
    suggestions = [];
  }

  /* ---------------- do not disturb ---------------- */

  function pauseFor(minutes) {
    state.settings.pausedUntil = Date.now() + Math.max(1, minutes) * 60000;
    save();
    Sound.stop();
    Voice.stop();
    renderAll();
    haptic(16);
    toast(isPaused() ? "Do Not Disturb is on." : "Reminders resumed.");
  }

  function pauseUntilTomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(WR.toMinutes(state.office.start) / 60 | 0, WR.toMinutes(state.office.start) % 60, 0, 0);
    state.settings.pausedUntil = d.getTime();
    save();
    Sound.stop();
    Voice.stop();
    renderAll();
    haptic(16);
    toast("Paused until tomorrow at " + fmtTime(state.office.start) + ".");
  }

  function resumeNow() {
    state.settings.pausedUntil = 0;
    save();
    renderAll();
    haptic(16);
    toast("Reminders resumed.");
  }

  /* ---------------- office hours ---------------- */

  function saveOffice() {
    const o = {
      start: $("offStart").value,
      end: $("offEnd").value,
      lunchStart: $("offLunchStart").value,
      lunchEnd: $("offLunchEnd").value,
      days: Array.from(officeDays).sort(),
    };
    if (!/^\d{1,2}:\d{2}$/.test(o.start) || !/^\d{1,2}:\d{2}$/.test(o.end)) {
      setHelper("officeStatus", "Choose a valid start and end time.", true);
      return;
    }
    if (WR.toMinutes(o.end) <= WR.toMinutes(o.start)) {
      setHelper("officeStatus", "The end time must be after the start time.", true);
      return;
    }
    if (!/^\d{1,2}:\d{2}$/.test(o.lunchStart) || !/^\d{1,2}:\d{2}$/.test(o.lunchEnd)) {
      setHelper("officeStatus", "Choose a valid lunch start and end time.", true);
      return;
    }
    if (WR.toMinutes(o.lunchEnd) <= WR.toMinutes(o.lunchStart)) {
      setHelper("officeStatus", "Lunch must end after it starts.", true);
      return;
    }
    if (!o.days.length) {
      setHelper("officeStatus", "Select at least one working day.", true);
      return;
    }
    state.office = WR.normalizeOffice(o);
    save();
    renderAll();
    setHelper("officeStatus", "Office hours saved.");
    haptic(18);
    toast("Office hours updated.");
  }

  /* ---------------- stopwatch ---------------- */

  function swToggle() {
    const sw = state.stopwatch;
    if (sw.running) {
      sw.accumulated = swElapsed();
      sw.running = false;
      sw.startedAt = 0;
      swPerfStart = 0;
    } else {
      sw.running = true;
      sw.startedAt = Date.now();
      swPerfStart = typeof performance !== "undefined" ? performance.now() : 0;
    }
    save();
    renderFocus();
    haptic(14);
  }

  function swLap() {
    const sw = state.stopwatch;
    if (!sw.running) return;
    const total = swElapsed();
    const prev = (sw.laps || []).reduce((a, b) => a + b, 0);
    sw.laps = (sw.laps || []).slice(-499).concat([Math.max(0, total - prev)]);
    save();
    renderFocus();
    haptic(10);
  }

  function swReset() {
    state.stopwatch = { running: false, startedAt: 0, accumulated: 0, laps: [] };
    swPerfStart = 0;
    stopStopwatchLoop();
    save();
    renderFocus();
    toast("Stopwatch reset.");
  }

  /* ---------------- wake lock ---------------- */

  async function applyWakeLock() {
    if (!state) return;
    if (!state.settings.keepAwake) {
      if (wakeSentinel) { try { await wakeSentinel.release(); } catch (e) {} wakeSentinel = null; }
      setHelper("wakeStatus", "");
      return;
    }
    if (!("wakeLock" in navigator)) {
      setHelper("wakeStatus", "This browser does not support screen wake lock. Keep the screen on manually.", true);
      return;
    }
    if (wakeSentinel) return;
    try {
      wakeSentinel = await navigator.wakeLock.request("screen");
      setHelper("wakeStatus", "Screen will stay awake while this app is open.");
      wakeSentinel.addEventListener("release", () => { wakeSentinel = null; });
    } catch (e) {
      setHelper("wakeStatus", "Could not keep the screen awake — check browser permissions.", true);
    }
  }

  /* ---------------- backup ---------------- */

  function backupObject() {
    return {
      kind: "workreminder-backup",
      app: APP.name,
      version: APP.version,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      office: state.office,
      reminders: state.reminders,
      screen: state.screen,
      stopwatch: state.stopwatch,
    };
  }

  async function exportBackup() {
    const data = JSON.stringify(backupObject(), null, 2);
    const name = "work-reminder-backup-" + WR.todayKey() + ".json";
    setHelper("dataStatus", "");
    try {
      if (navigator.canShare && window.File) {
        const file = new File([data], name, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Work Reminder backup" });
          setHelper("dataStatus", "Backup shared successfully.");
          return;
        }
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    try {
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setHelper("dataStatus", "Backup downloaded — keep it somewhere safe.");
    } catch (e) {
      setHelper("dataStatus", "Could not create the backup on this browser.", true);
    }
  }

  async function importBackup(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setHelper("dataStatus", "That file is too large (2 MB maximum).", true);
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      setHelper("dataStatus", "That file is not valid JSON.", true);
      return;
    }
    if (!parsed || !Array.isArray(parsed.reminders)) {
      setHelper("dataStatus", "This backup has no reminders list.", true);
      return;
    }
    if (parsed.reminders.length > 1000) {
      setHelper("dataStatus", "That backup has too many reminders (1000 maximum).", true);
      return;
    }
    const ok = await askConfirm("Restore backup?",
      "This replaces your current " + state.reminders.length + " reminders and settings with " +
      parsed.reminders.length + " from the backup.", "Restore");
    if (!ok) return;

    state.settings = WR.normalizeSettings(parsed.settings);
    state.settings.pausedUntil = 0;
    state.settings.enabled = true;
    state.office = WR.normalizeOffice(parsed.office);
    state.reminders = parsed.reminders.map((r, i) => WR.normalizeReminder(r, "r_import_" + i));
    state.screen = WR.normalizeScreen(parsed.screen);
    state.stopwatch = WR.normalizeStopwatch(parsed.stopwatch);
    state.seeded = true;
    officeDays = new Set(state.office.days);
    save();
    renderAll();
    setHelper("dataStatus", "Backup restored — " + state.reminders.length + " reminders loaded.");
    haptic(24);
    toast("Backup restored.");
  }

  async function resetApp() {
    const ok = await askConfirm("Reset Work Reminder?",
      "Every reminder, setting and backup in this browser will be replaced with the default schedule.", "Reset");
    if (!ok) return;
    dismissAlert();
    Sound.stop();
    Voice.stop();
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    firstRun = true;
    loadState();
    renderAll();
    haptic([20, 60, 20]);
    toast("App reset to the default schedule.");
  }

  /* ---------------- install ---------------- */

  async function installApp() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try {
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === "accepted") {
          setHelper("installStatus", "Installing — check your home screen.");
        } else {
          setHelper("installStatus", "Install cancelled. You can try again any time.");
        }
      } catch (e) {
        setHelper("installStatus", "Could not open the install prompt.", true);
      }
      deferredPrompt = null;
      return;
    }
    if (IOS) {
      setHelper("installStatus", "On iPhone/iPad: tap Share in Safari, then “Add to Home Screen”.");
      toast("Use Share → Add to Home Screen.");
      return;
    }
    setHelper("installStatus", "Use your browser menu → “Install app” or “Add to Home screen”.");
  }

  /* ---------------- alarm engine ---------------- */

  function todayAt(hhmm, now) {
    const d = new Date(now || Date.now());
    d.setHours(0, 0, 0, 0);
    d.setMinutes(WR.toMinutes(hhmm));
    return d;
  }

  function remIsDue(rem, now) {
    if (!rem || !rem.enabled) return false;
    if (rem.repeat === "once" && rem.completed) return false;

    if (rem.snoozedUntil && +rem.snoozedUntil > 0) {
      const sn = new Date(+rem.snoozedUntil);
      if (now.getTime() < sn.getTime()) return false;
      return now.getTime() - sn.getTime() <= CATCHUP_MS;
    }

    let due;
    if (rem.repeat === "once") {
      due = rem.at ? new Date(+rem.at) : todayAt(rem.time, now);
      if (rem.at && WR.todayKey(due) !== WR.todayKey(now)) return false;
    } else {
      if (rem.lastCompletedDate === WR.todayKey(now)) return false;
      if (!WR.isActiveDay(rem, now)) return false;
      due = todayAt(rem.time, now);
    }
    const late = now.getTime() - due.getTime();
    if (late < 0 || late > CATCHUP_MS) return false;
    if (rem.lastFiredAt && rem.lastFiredAt >= due.getTime()) return false;
    return true;
  }

  function checkDue() {
    if (!state || checking || !state.settings.enabled) return;
    checking = true;
    try {
      if (isPaused()) return;
      const now = new Date();
      const due = [];
      for (const r of state.reminders) {
        if (remIsDue(r, now)) due.push(r);
      }
      if (!due.length) return;
      const stamp = now.getTime();
      for (const r of due) {
        r.lastFiredAt = stamp;
        r.snoozedUntil = 0;
        r.updatedAt = stamp;
      }
      save();
      fireAlert(due[0], due.length - 1);
      for (let i = 1; i < due.length; i++) sendNotification(due[i]);
      renderAll();
    } catch (e) {
      // Never let a single bad reminder break the alarm loop.
      console.warn("Reminder check failed", e);
    } finally {
      checking = false;
    }
  }

  function fireAlert(rem, extra) {
    activeAlert = { id: rem.id, at: Date.now() };
    $("alertTitle").textContent = rem.title + (extra > 0 ? " (+" + extra + " more due)" : "");
    $("alertMeta").textContent = fmtTime(WR.displayTime(rem, new Date())) +
      (rem.message ? " · " + rem.message : " · due now");
    $("alertBanner").classList.remove("hidden");
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => { if (activeAlert) dismissAlert(); }, 90000);

    if (rem.sound && rem.sound !== "none") {
      try { Sound.unlock(); } catch (e) {}
      Sound.play(rem.sound, state.settings.sound.volume);
    }
    if (rem.voiceEnabled && state.settings.voiceEnabled) {
      Voice.speak(rem.message || rem.title, voiceConfig());
    }
    if (state.settings.haptics) haptic([40, 60, 40, 60, 40]);
    sendNotification(rem);
  }

  function dismissAlert() {
    activeAlert = null;
    clearTimeout(alertTimer);
    $("alertBanner").classList.add("hidden");
    Sound.stop();
    Voice.stop();
  }

  function voiceConfig() {
    const v = state.settings.voice;
    return { language: v.language, gender: v.gender, speed: v.speed, volume: v.volume };
  }

  async function sendNotification(rem) {
    if (!state || !state.settings.notificationsEnabled || !rem.notificationEnabled) return;
    if (!rem || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const opts = {
      body: rem.message || "It's time for " + rem.title + ".",
      tag: "wr-" + rem.id,
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      silent: false,
      vibrate: state.settings.haptics ? [40, 60, 40] : undefined,
      data: { id: rem.id, at: Date.now() },
      actions: [
        { action: "done", title: "Mark done" },
        { action: "snooze", title: "Snooze " + state.settings.defaultSnooze + "m" },
      ],
    };
    try {
      if (swReg && swReg.showNotification) {
        await swReg.showNotification(rem.title, opts);
        return;
      }
    } catch (e) {}
    try { new Notification(rem.title, opts); } catch (e) {}
  }

  async function testNotification() {
    await enableNotifications(true);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      toast("Notifications are not available — sound alerts still work.", true);
      return;
    }
    const rem = {
      id: "test-notification",
      title: "Work Reminder test",
      message: "Notifications are working. This is how a reminder will look.",
      notificationEnabled: true,
    };
    await sendNotification(rem);
    toast("Test notification sent.");
  }

  async function enableNotifications(silent) {
    if (typeof Notification === "undefined") {
      setHelper("permText", "This browser cannot show system notifications. In-app alerts still work.", true);
      if (!silent) toast("This browser does not support notifications.", true);
      return false;
    }
    Sound.unlock();
    if (Notification.permission === "denied") {
      setHelper("permText", "Notifications are blocked. Open this site's permissions in your browser settings and allow notifications.", true);
      if (!silent) toast("Notifications are blocked in browser settings.", true);
      return false;
    }
    if (Notification.permission === "default") {
      try {
        const p = await Notification.requestPermission();
        if (p !== "granted") {
          if (!silent) toast("Notification permission was not granted.", true);
          renderSettings();
          return false;
        }
      } catch (e) {
        if (!silent) toast("Could not request notification permission.", true);
        return false;
      }
    }
    try {
      if (state) {
        state.settings.notificationsEnabled = true;
        save();
      }
    } catch (e) {}
    renderSettings();
    updateHeader();
    if (!silent) toast("Notifications enabled.");
    return true;
  }

  async function previewSound(name) {
    Sound.unlock();
    const chosen = name || $("soundSelect").value || state.settings.sound.name;
    const vol = state.settings.sound.volume;
    if (chosen === "none") {
      toast("Sound is set to none.");
      return;
    }
    const ok = Sound.play(chosen, vol);
    if (!ok) toast("Could not play audio — tap once on the page and try again.", true);
  }

  async function testVoice() {
    Sound.unlock();
    try { Voice.unlock(); } catch (e) {}
    const el = $("voiceStatus");
    if (el) {
      el.hidden = false;
      el.classList.remove("error");
      el.textContent = "Starting the voice test…";
    }
    const up = upcomingList();
    const text = up.length && (up[0].r.message || "").trim()
      ? up[0].r.message.trim()
      : "Please return your cup to the kitchen.";
    const res = await Voice.speak(text, voiceConfig());
    if (!el) return;
    el.classList.remove("error");
    if (!res) {
      el.textContent = "Could not start the voice test.";
    } else if (res.ok) {
      if (res.approximate) {
        el.textContent = "Playing with " + (res.voice || "the closest system voice") +
          " - this phone has no separate " + (state.settings.voice.gender === "male" ? "male" : "female") +
          " voice, so the pitch is adjusted.";
      } else {
        el.textContent = "Playing with " + (res.voice || "the system voice") + ".";
      }
    } else if (res.error === "synthesis-failed" || res.error === "speech-did-not-start" || res.error === "audio-busy") {
      el.textContent = "The phone's speech engine refused to start. Tap Test voice once more. If it keeps failing, set Voice to System default, or install a text-to-speech voice in your phone settings.";
    } else if (res.error === "not-allowed") {
      el.textContent = "The phone blocked speech. Tap Test voice again so the browser receives a direct tap, then try the reminder.";
    } else if (res.error === "no-voices" || res.error === "no-speech-engine") {
      el.textContent = "This browser has no speech voices installed. Try Chrome, Edge or Safari.";
    } else {
      el.textContent = "Voice test failed: " + res.error;
    }
  }

  /* ---------------- app updates ---------------- */

  function readStoredUpdateInfo() {
    try {
      const d = JSON.parse(localStorage.getItem(UPDATE_INFO_KEY) || "null");
      if (!d || typeof d !== "object" || typeof d.version !== "string") return null;
      const version = d.version.trim().replace(/^v/i, "");
      if (!/^\d+(\.\d+){0,2}$/.test(version)) return null;
      return {
        version,
        released: typeof d.released === "string" ? d.released : "",
        notes: Array.isArray(d.notes) ? d.notes.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12) : [],
      };
    } catch (e) {
      return null;
    }
  }

  function cacheUpdateInfo(info) {
    if (!info) return;
    try { localStorage.setItem(UPDATE_INFO_KEY, JSON.stringify(info)); } catch (e) {}
  }

  function updateKey() {
    return updateInfo && updateInfo.version ? updateInfo.version : "worker";
  }

  function setUpdateStatus(msg, isError) {
    updateMessage = msg || "";
    updateMessageError = !!isError;
    renderUpdateUI();
  }

  function renderUpdateUI() {
    const version = APP.version;
    const newer = !!(updateInfo && updateInfo.version && WR.compareVersions(updateInfo.version, version) > 0);
    const workerReady = !!(swReg && swReg.waiting);
    const available = newer || workerReady || !!(updateInfo && updateInfo.workerReady);

    const strip = $("updateStrip");
    if (strip) {
      const show = available && dismissedUpdate !== updateKey();
      strip.classList.toggle("hidden", !show);
      if (show) {
        const title = $("updateStripTitle");
        const text = $("updateStripText");
        if (title) title.textContent = newer ? "Update available" : "Update ready";
        if (text) {
          text.textContent = newer
            ? "Version v" + updateInfo.version + " is ready. One tap installs it."
            : "A new version of Work Reminder is ready to install.";
        }
      }
    }

    const badge = $("updateBadge");
    if (badge) badge.textContent = "v" + version;

    const notesWrap = $("updateNotesWrap");
    const notes = newer ? (updateInfo.notes || []) : [];
    if (notesWrap) {
      notesWrap.classList.toggle("hidden", !notes.length);
      if (notes.length) {
        const ver = $("updateVersion");
        if (ver) ver.textContent = "v" + updateInfo.version;
        const list = $("updateNotes");
        if (list) list.innerHTML = notes.map((n) => "<li>" + escapeHtml(n) + "</li>").join("");
      }
    }

    const btn = $("updateBtn");
    if (btn) {
      btn.disabled = updateChecking || updateApplying;
      btn.textContent = updateApplying
        ? "Updating…"
        : available
          ? "Update now"
          : updateChecking
            ? "Checking…"
            : "Check for updates";
    }

    const whatsNew = $("whatsNewBtn");
    if (whatsNew) {
      whatsNew.classList.toggle("hidden", !(whatsNewInfo && whatsNewInfo.notes && whatsNewInfo.notes.length));
    }

    const status = updateMessage || (available
      ? (newer
        ? "Version v" + updateInfo.version + " is available. Your data stays on this device."
        : "A new version is ready to install.")
      : lastCheckFailed
        ? "Could not check for updates. You're on v" + version + "."
        : "You're on the latest version (v" + version + ").");
    setHelper("updateStatus", status, updateMessageError);
  }

  /* Called once on boot: remember the running version and welcome people who
     just moved to a newer build with a toast and an "updated" notification. */
  function noteVersionOnBoot() {
    let previous = "";
    try { previous = localStorage.getItem(VERSION_KEY) || ""; } catch (e) {}
    try { localStorage.setItem(VERSION_KEY, APP.version); } catch (e) {}

    const stored = readStoredUpdateInfo();
    if (stored) {
      const cmp = WR.compareVersions(stored.version, APP.version);
      if (cmp > 0) updateInfo = stored;
      else if (cmp === 0) whatsNewInfo = stored;
    }

    if (firstRun) return;
    const upgraded = previous
      ? WR.compareVersions(APP.version, previous) > 0
      : Date.now() - (+state.installedAt || Date.now()) > 5 * 60 * 1000;
    if (!upgraded) return;

    dismissedUpdate = "";
    try { localStorage.removeItem(UPDATE_DISMISSED_KEY); } catch (e) {}

    setTimeout(() => {
      if (!state) return;
      const hasNotes = !!(whatsNewInfo && whatsNewInfo.notes && whatsNewInfo.notes.length);
      toast("Updated to v" + APP.version + (hasNotes ? ". Tap “What's new” in Settings." : "."));
      showUpdateNotification("updated", whatsNewInfo || { version: APP.version, notes: [] });
    }, 4000);
  }

  async function checkForUpdates(manual) {
    if (updateChecking || updateApplying) return;
    updateChecking = true;
    lastUpdateCheck = Date.now();
    lastCheckFailed = false;
    if (manual) {
      updateMessage = "Checking for updates…";
      updateMessageError = false;
      renderUpdateUI();
    }

    let remote = null;
    let failed = false;
    try {
      // A stalled request must never leave the button stuck on "Checking…",
      // so give the manifest a hard deadline and always clear the flag below.
      const abort = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = abort ? setTimeout(() => abort.abort(), 8000) : 0;
      try {
        const res = await fetch("version.json?ts=" + Date.now(), {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: abort ? abort.signal : undefined,
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const raw = data && typeof data.version === "string"
          ? data.version.trim().replace(/^v/i, "")
          : "";
        if (!/^\d+(\.\d+){0,2}$/.test(raw)) throw new Error("Invalid version.json");
        remote = {
          version: raw,
          released: typeof data.released === "string" ? data.released : "",
          notes: Array.isArray(data.notes)
            ? data.notes.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12)
            : [],
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (e) {
      failed = true;
    }

    try {
      lastCheckFailed = failed;

      const waiting = !!(swReg && swReg.waiting);
      if (remote && WR.compareVersions(remote.version, APP.version) > 0) {
        if (!updateInfo || updateInfo.version !== remote.version) {
          dismissedUpdate = "";
          try { localStorage.removeItem(UPDATE_DISMISSED_KEY); } catch (e) {}
        }
        updateInfo = remote;
        whatsNewInfo = null;
        cacheUpdateInfo(remote);
        maybeNotifyUpdate(remote);
        if (manual) {
          updateMessage = "Version v" + remote.version + " is available.";
          updateMessageError = false;
        }
      } else if (waiting) {
        if (!updateInfo) updateInfo = { version: "", notes: [], workerReady: true };
        if (manual) {
          updateMessage = "A new version is ready to install.";
          updateMessageError = false;
        }
      } else {
        updateInfo = null;
        if (remote && WR.compareVersions(remote.version, APP.version) === 0) {
          whatsNewInfo = remote;
          if (manual) {
            updateMessage = "You're on the latest version (v" + APP.version + ").";
            updateMessageError = false;
          }
        } else if (failed) {
          if (manual) {
            updateMessage = navigator.onLine === false
              ? "You're offline. Showing the installed version (v" + APP.version + ")."
              : "Could not reach the update server. Try again in a moment.";
            updateMessageError = true;
          }
        } else if (manual) {
          updateMessage = "You're on the latest version (v" + APP.version + ").";
          updateMessageError = false;
        }
      }
    } catch (e) {
      failed = true;
      lastCheckFailed = true;
    } finally {
      updateChecking = false;
      renderUpdateUI();
    }
  }

  function maybeNotifyUpdate(info) {
    if (!info || !info.version) return;
    if (!hasNotifications() || !state || !state.settings.notificationsEnabled || isPaused()) return;
    let notified = "";
    try { notified = localStorage.getItem(UPDATE_NOTIFIED_KEY) || ""; } catch (e) {}
    if (notified === info.version) return;
    try { localStorage.setItem(UPDATE_NOTIFIED_KEY, info.version); } catch (e) {}
    showUpdateNotification("available", info);
  }

  async function showUpdateNotification(kind, info) {
    if (!info) return;
    if (!hasNotifications() || !state || !state.settings.notificationsEnabled || isPaused()) return;
    const version = info.version || APP.version;
    const available = kind === "available";
    const opts = {
      body: available
        ? "Version v" + version + " is ready. Tap to update."
        : "You're now on v" + version + ". Tap to see what's new.",
      tag: "wr-update-" + (available ? "available-" + version : "done-" + version),
      renotify: available,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      silent: false,
      vibrate: state.settings.haptics ? [30, 50, 30] : undefined,
      data: available ? { update: true, version } : { whatsnew: true, version },
    };
    if (available) opts.actions = [{ action: "update", title: "Update now" }];

    const title = available ? "Work Reminder update available" : "Work Reminder updated";
    if (await notifyViaWorker(title, opts)) return;

    try {
      const reg = swReg || (navigator.serviceWorker ? await navigator.serviceWorker.ready : null);
      if (reg && reg.showNotification) await reg.showNotification(title, opts);
    } catch (e) {}
  }

  /* Ask the active service worker to raise the notification. Resolves false
     (so the caller can fall back) if there is no worker or it does not reply. */
  function notifyViaWorker(title, opts) {
    return new Promise((resolve) => {
      if (!("serviceWorker" in navigator)) return resolve(false);
      navigator.serviceWorker.ready.then((reg) => {
        const worker = reg.active;
        if (!worker || !worker.postMessage) return resolve(false);

        const id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2);
        let done = false;
        let timer = 0;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("message", onMessage);
          resolve(ok);
        };
        const onMessage = (e) => {
          const d = e.data || {};
          if (d.type === "WR_NOTIFY_RESULT" && d.id === id) finish(!!d.ok);
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        timer = setTimeout(() => finish(false), 4000);
        worker.postMessage({ type: "WR_NOTIFY", id, title, options: opts });
      }).catch(() => resolve(false));
    });
  }

  function waitForInstalledWorker(reg, timeout) {
    return new Promise((resolve) => {
      if (!reg) return resolve(null);
      if (reg.waiting) return resolve(reg.waiting);

      let settled = false;
      let poll = 0;
      let timer = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve(value);
      };
      const watch = () => {
        const worker = reg.installing;
        if (!worker) return false;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") finish(worker);
          else if (worker.state === "redundant") finish(null);
        });
        return true;
      };

      if (!watch()) {
        // update() can resolve just before the browser exposes `installing`.
        poll = setInterval(() => {
          if (reg.waiting) { finish(reg.waiting); return; }
          if (watch()) clearInterval(poll);
        }, 120);
      }
      timer = setTimeout(() => finish(reg.waiting || null), timeout || 12000);
    });
  }

  async function applyUpdate() {
    if (updateApplying) return;
    updateApplying = true;
    updateMessage = "Preparing the update…";
    updateMessageError = false;
    dismissedUpdate = "";
    try { localStorage.removeItem(UPDATE_DISMISSED_KEY); } catch (e) {}
    renderUpdateUI();
    haptic([12, 45, 12]);

    try {
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        let worker = swReg && swReg.waiting;
        if (!worker && swReg) {
          try { await swReg.update(); } catch (e) {}
          worker = await waitForInstalledWorker(swReg, 12000);
        }
        if (worker) {
          reloadAfterUpdate = true;
          updateMessage = "Installing the update…";
          renderUpdateUI();
          worker.postMessage({ type: "SKIP_WAITING" });
          // controllerchange reloads sooner; this is a safety net.
          setTimeout(() => { if (reloadAfterUpdate) location.reload(); }, 5000);
          return;
        }
      }
      await refreshLatest();
    } catch (e) {
      updateApplying = false;
      updateMessage = "Could not update automatically. Close and reopen the app, or pull to refresh.";
      updateMessageError = true;
      renderUpdateUI();
    }
  }

  async function refreshLatest() {
    if (navigator.onLine === false) {
      updateApplying = false;
      updateMessage = "You're offline. Reconnect to the internet, then tap Update again.";
      updateMessageError = true;
      renderUpdateUI();
      return;
    }
    updateMessage = "Reloading the latest version…";
    renderUpdateUI();
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {}
    reloadAfterUpdate = false;
    location.reload();
  }

  function watchForUpdates(reg) {
    if (!reg || reg.__wrWatched) return;
    reg.__wrWatched = true;
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state !== "installed") return;
        if (!navigator.serviceWorker.controller) return; // first install, not an update
        if (!updateInfo) updateInfo = { version: "", notes: [], workerReady: true };
        renderUpdateUI();
      });
    });
  }

  function openWhatsNew(info) {
    const stored = readStoredUpdateInfo();
    const src = info || whatsNewInfo ||
      (stored && WR.compareVersions(stored.version, APP.version) === 0 ? stored : null);
    const notes = src && src.notes && src.notes.length
      ? src.notes
      : ["This build includes stability, performance and reliability improvements."];

    const versionEl = $("whatsNewVersion");
    if (versionEl) versionEl.textContent = "v" + APP.version;
    const dateEl = $("whatsNewDate");
    if (dateEl) {
      dateEl.textContent = src && src.released
        ? "Released " + src.released
        : "Installed " + new Date((state && state.installedAt) || Date.now()).toLocaleDateString();
    }
    const list = $("whatsNewList");
    if (list) list.innerHTML = notes.map((n) => "<li>" + escapeHtml(n) + "</li>").join("");
    openSheet("whatsNewSheet");
  }

  /* ---------------- clock, screen time and loop ---------------- */

  let lastTickAt = Date.now();
  let lastScreenSave = 0;

  function trackScreen(now) {
    if (document.visibilityState !== "visible") { lastTickAt = now.getTime(); return; }
    const delta = Math.max(0, Math.min(10000, now.getTime() - lastTickAt));
    lastTickAt = now.getTime();
    const key = WR.todayKey(now);
    if (!state.screen || state.screen.day !== key) {
      state.screen = { day: key, ms: 0, last: now.getTime() };
    }
    state.screen.ms = Math.min(24 * 60 * 60 * 1000, (+state.screen.ms || 0) + delta);
    state.screen.last = now.getTime();
    if (now.getTime() - lastScreenSave > 20000) {
      lastScreenSave = now.getTime();
      save();
    }
  }

  function tick() {
    if (!state) return;
    const now = new Date();
    trackScreen(now);
    checkDue();

    if (WR.todayKey(now) !== lastDay) {
      lastDay = WR.todayKey(now);
      if (state.screen.day !== lastDay) state.screen = { day: lastDay, ms: 0, last: now.getTime() };
      renderAll();
    }

    const minute = now.getHours() * 60 + now.getMinutes();
    if (minute !== lastMinute) {
      lastMinute = minute;
      if (view === "home") renderHome();
      if (view === "settings") updateHeader();
    }

    if (view === "focus") {
      $("clockTime").textContent = now.toLocaleTimeString([], {
        hour12: state.settings.hourFormat !== 24, hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      // Fallback repaint; the animation-frame loop owns the smooth updates.
      paintStopwatch();
      if (state.settings.keepAwake && state.stopwatch.running) {
        const wd = workdayInfo(now);
        $("workdayBar").style.width = Math.max(0, Math.min(100, wd.pct)) + "%";
        $("workdayLeft").textContent = wd.left;
      }
    }
  }

  /* ---------------- notification actions ---------------- */

  function handleNotificationAction(action, id) {
    if (action === "done" && id) markDone(id);
    else if (action === "snooze" && id) snoozeReminder(id, state.settings.defaultSnooze);
    else if (action === "open") showView("home");
  }

  /* ---------------- event wiring ---------------- */

  function bindEvents() {
    $$(".tab").forEach((b) => b.addEventListener("click", () => {
      haptic(8);
      showView(b.dataset.view);
      if (b.dataset.view === "settings") {
        renderUpdateUI();
        if (Date.now() - lastUpdateCheck > 60000) checkForUpdates(false);
      }
    }));

    $("dndBtn").addEventListener("click", () => { updateHeader(); openSheet("dndSheet"); });
    $("alertsBtn").addEventListener("click", () => {
      showView("settings");
      const card = $("permText").closest(".card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    $("enableAlertsBtn").addEventListener("click", () => enableNotifications());
    $("enableAlertsBtn2").addEventListener("click", () => {
      const p = notificationState();
      if (p === "denied") toast("Allow notifications in your browser's site settings.", true);
      else if (p === "unsupported") toast("This browser has no notification API.", true);
      else if (p === "granted") testNotification();
      else enableNotifications();
    });

    $("installStripBtn").addEventListener("click", installApp);
    $("installBtn").addEventListener("click", installApp);

    $("updateBtn").addEventListener("click", () => {
      if (updateInfo) applyUpdate();
      else checkForUpdates(true);
    });
    $("updateStripBtn").addEventListener("click", () => {
      if (updateInfo) applyUpdate();
      else checkForUpdates(true);
    });
    $("whatsNewBtn").addEventListener("click", () => openWhatsNew());
    $("whatsNewClose").addEventListener("click", () => closeSheet("whatsNewSheet"));
    $("updateStripClose").addEventListener("click", () => {
      dismissedUpdate = updateKey();
      try { localStorage.setItem(UPDATE_DISMISSED_KEY, dismissedUpdate); } catch (e) {}
      renderUpdateUI();
    });

    $("nextSnooze").addEventListener("click", () => {
      if (currentNext) snoozeReminder(currentNext.id, state.settings.defaultSnooze);
    });
    $("nextDone").addEventListener("click", () => {
      if (currentNext) markDone(currentNext.id);
    });
    $("nextEdit").addEventListener("click", () => {
      if (currentNext) openReminder(currentNext.id);
    });

    $("alertDone").addEventListener("click", () => {
      if (activeAlert) markDone(activeAlert.id);
    });
    $("alertSnooze").addEventListener("click", () => {
      if (activeAlert) snoozeReminder(activeAlert.id, state.settings.defaultSnooze);
    });
    $("alertClose").addEventListener("click", dismissAlert);

    $("quickChips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-quick]");
      if (!btn) return;
      quickMinutes = +btn.dataset.quick;
      $$("#quickChips .chip-btn").forEach((b) => b.classList.toggle("on", +b.dataset.quick === quickMinutes));
      haptic(8);
    });
    $("quickAdd").addEventListener("click", addQuick);
    $("quickText").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addQuick(); }
    });

    $("todayList").addEventListener("click", (e) => {
      const tick = e.target.closest("[data-tick]");
      if (tick) { toggleDone(tick.dataset.tick); return; }
      const li = e.target.closest("li[data-id]");
      if (li) openReminder(li.dataset.id);
    });

    $("filterChips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      filterCategory = btn.dataset.filter;
      renderFilters();
      renderReminderList();
      haptic(8);
    });

    let searchTimer = 0;
    $("scheduleSearch").addEventListener("input", (e) => {
      searchTerm = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderReminderList, 120);
    });

    $("addReminderBtn").addEventListener("click", () => openReminder(null));
    $("fabAdd").addEventListener("click", () => { haptic(10); openReminder(null); });

    $("reminderList").addEventListener("click", (e) => {
      if (e.target.closest(".switch")) return;
      const li = e.target.closest("[data-open]");
      if (li) openReminder(li.dataset.open);
    });
    $("reminderList").addEventListener("change", (e) => {
      const input = e.target.closest("[data-toggle]");
      if (input) toggleEnabled(input.dataset.toggle, input.checked);
    });

    $("editOfficeBtn").addEventListener("click", () => {
      const acc = $("offStart").closest("details");
      if (acc) {
        acc.open = true;
        acc.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    $("suggestBtn").addEventListener("click", openSuggestions);
    $("suggestAdd").addEventListener("click", addSuggestions);
    $("suggestCancel").addEventListener("click", () => closeSheet("suggestSheet"));
    $("suggestCustomize").addEventListener("click", () => {
      closeSheet("suggestSheet");
      openReminder(null);
    });

    $("pause30").addEventListener("click", () => pauseFor(30));
    $("pause60").addEventListener("click", () => pauseFor(60));
    $("pauseTomorrow").addEventListener("click", pauseUntilTomorrow);
    $("resumeNow").addEventListener("click", resumeNow);
    $("dnd30").addEventListener("click", () => { pauseFor(30); closeSheet("dndSheet"); });
    $("dnd60").addEventListener("click", () => { pauseFor(60); closeSheet("dndSheet"); });
    $("dndTomorrow").addEventListener("click", () => { pauseUntilTomorrow(); closeSheet("dndSheet"); });
    $("dndResume").addEventListener("click", () => { resumeNow(); closeSheet("dndSheet"); });

    /* settings */
    $("notifToggle").addEventListener("change", async (e) => {
      if (e.target.checked) {
        const ok = await enableNotifications(true);
        state.settings.notificationsEnabled = ok;
        e.target.checked = ok;
        save();
        renderSettings();
      } else {
        state.settings.notificationsEnabled = false;
        save();
        toast("Reminder notifications are off.");
      }
    });
    $("voiceToggle").addEventListener("change", (e) => {
      state.settings.voiceEnabled = e.target.checked;
      save();
      $("voiceBadge").textContent = e.target.checked ? "On" : "Off";
      if (!e.target.checked) Voice.stop();
    });
    $("hapticsToggle").addEventListener("change", (e) => {
      state.settings.haptics = e.target.checked;
      save();
      if (e.target.checked) haptic(20);
    });
    $("wakeToggle").addEventListener("change", (e) => {
      state.settings.keepAwake = e.target.checked;
      save();
      applyWakeLock();
    });

    $("soundSelect").addEventListener("change", (e) => {
      state.settings.sound.name = e.target.value;
      save();
      previewSound(e.target.value);
    });
    $("soundVolume").addEventListener("input", (e) => {
      state.settings.sound.volume = clamp(e.target.value, 0, 100, 80);
      $("soundVolLabel").textContent = state.settings.sound.volume + "%";
      saveSoon();
    });
    $("soundVolume").addEventListener("change", () => previewSound());

    $("voiceLang").addEventListener("change", (e) => {
      state.settings.voice.language = e.target.value;
      save();
    });
    $("voiceGender").addEventListener("change", (e) => {
      state.settings.voice.gender = e.target.value;
      save();
      testVoice();
    });
    $("voiceSpeed").addEventListener("change", (e) => {
      state.settings.voice.speed = e.target.value;
      save();
      testVoice();
    });
    $("voiceVolume").addEventListener("input", (e) => {
      state.settings.voice.volume = clamp(e.target.value, 0, 100, 80);
      $("voiceVolLabel").textContent = state.settings.voice.volume + "%";
      saveSoon();
    });
    $("snoozeSelect").addEventListener("change", (e) => {
      state.settings.defaultSnooze = clamp(e.target.value, 1, 1440, 5);
      save();
    });

    $("themeSeg").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-theme-set]");
      if (!btn) return;
      state.settings.theme = btn.dataset.themeSet;
      save();
      applyTheme();
      renderSettings();
      haptic(8);
    });
    $("hourSeg").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-hour]");
      if (!btn) return;
      state.settings.hourFormat = +btn.dataset.hour === 24 ? 24 : 12;
      save();
      renderAll();
    });

    $("previewSoundBtn").addEventListener("click", () => previewSound());
    $("testNotifBtn").addEventListener("click", testNotification);
    $("testVoiceBtn").addEventListener("click", testVoice);

    $("offDays").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-office-day]");
      if (!btn) return;
      const d = +btn.dataset.officeDay;
      if (officeDays.has(d)) officeDays.delete(d);
      else officeDays.add(d);
      renderOfficeDays();
      haptic(8);
    });
    $("saveOfficeBtn").addEventListener("click", saveOffice);

    $("exportBtn").addEventListener("click", exportBackup);
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      await importBackup(file);
    });
    $("resetBtn").addEventListener("click", resetApp);

    $("swToggle").addEventListener("click", swToggle);
    $("swLap").addEventListener("click", swLap);
    $("swReset").addEventListener("click", swReset);

    /* reminder form */
    $("reminderForm").addEventListener("submit", saveReminder);
    $("fCancel").addEventListener("click", closeReminder);
    $("fDelete").addEventListener("click", deleteReminder);
    $("fDuplicate").addEventListener("click", duplicateReminder);
    $("fRepeat").addEventListener("change", toggleFormDays);
    $("fCategory").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      formCategory = btn.dataset.cat;
      $$("#fCategory .cat-choice").forEach((b) => b.classList.toggle("on", b.dataset.cat === formCategory));
      haptic(8);
    });
    $("fDays").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-form-day]");
      if (!btn) return;
      const d = +btn.dataset.formDay;
      if (formDays.has(d)) formDays.delete(d);
      else formDays.add(d);
      buildFormDays();
      haptic(8);
    });
    $("fPreview").addEventListener("click", () => previewSound($("fSound").value));

    /* confirm */
    $("confirmOk").addEventListener("click", () => settleConfirm(true));
    $("confirmCancel").addEventListener("click", () => settleConfirm(false));

    /* generic sheet closing */
    document.addEventListener("click", (e) => {
      const closer = e.target.closest("[data-close]");
      if (closer) {
        const id = closer.dataset.close;
        if (id === "confirmSheet") settleConfirm(false);
        else if (id === "reminderSheet") closeReminder();
        else closeSheet(id);
      }
      const wrap = e.target.closest(".sheet-wrap");
      if (wrap && e.target.classList.contains("sheet-backdrop")) {
        if (wrap.id === "confirmSheet") settleConfirm(false);
        else if (wrap.id === "reminderSheet") closeReminder();
        else closeSheet(wrap.id);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = $$(".sheet-wrap").filter((el) => !el.classList.contains("hidden"));
      if (!open.length) return;
      const top = open[open.length - 1];
      if (top.id === "confirmSheet") settleConfirm(false);
      else if (top.id === "reminderSheet") closeReminder();
      else closeSheet(top.id);
    });

    /* unlock audio on the first gesture — required by iOS Safari */
    const unlock = () => { Sound.unlock(); };
    document.addEventListener("pointerdown", unlock, { once: true, passive: true });
    document.addEventListener("keydown", unlock, { once: true });

    document.addEventListener("visibilitychange", () => {
      lastTickAt = Date.now();
      if (document.visibilityState === "visible") {
        rebaseStopwatch();
        applyWakeLock();
        checkDue();
        if (state) renderAll();
        if (state && state.stopwatch.running && view === "focus") startStopwatchLoop();
        if (Date.now() - lastUpdateCheck > UPDATE_RECHECK_MS) checkForUpdates(false);
      } else {
        stopStopwatchLoop();
        save();
      }
    });

    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      updateHeader();
    });
    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      updateHeader();
      toast("Work Reminder installed.");
    });

    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => { if (state && state.settings.theme === "system") applyTheme(); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (e) => {
        const d = e.data || {};
        if (d.type === "wr-action") handleNotificationAction(d.action, d.id);
        else if (d.type === "wr-update") {
          checkForUpdates(true).then(() => { if (updateInfo) applyUpdate(); });
        } else if (d.type === "wr-whatsnew") {
          openWhatsNew();
        }
      });

      // A new service worker took control. Reload only when the user asked to
      // update, so a background update never interrupts an open reminder.
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!reloadAfterUpdate) return;
        reloadAfterUpdate = false;
        location.reload();
      });
    }
  }

  /* ---------------- service worker + launch actions ---------------- */

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;
    try {
      swReg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      watchForUpdates(swReg);
      navigator.serviceWorker.ready.then((reg) => {
        swReg = reg;
        watchForUpdates(reg);
        renderUpdateUI();
        checkForUpdates(false);
      }).catch(() => {});
    } catch (e) {
      console.warn("Service worker registration failed", e);
    }
  }

  function handleLaunchAction(params) {
    const v = params.get("view");
    if (v && VIEWS.includes(v)) {
      showView(v);
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    }
    if (params.get("add") === "1") {
      setTimeout(() => openReminder(null), 350);
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
      return;
    }
    if (params.get("whatsnew") === "1") {
      setTimeout(() => openWhatsNew(), 500);
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
      return;
    }
    if (params.get("update") === "1") {
      setTimeout(async () => {
        await checkForUpdates(true);
        if (updateInfo) applyUpdate();
        else toast("You're already on the latest version (v" + APP.version + ").");
      }, 700);
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
      return;
    }
    const action = params.get("action");
    const id = params.get("id");
    if (!action || !id) return;
    if (action === "done") markDone(id);
    else if (action === "snooze") snoozeReminder(id, state.settings.defaultSnooze);
    try {
      const clean = location.pathname + location.hash;
      history.replaceState(null, "", clean);
    } catch (e) {}
  }

  /* ---------------- boot ---------------- */

  function init() {
    loadState();
    lastDay = WR.todayKey();
    lastMinute = new Date().getHours() * 60 + new Date().getMinutes();
    applyTheme();
    renderAll();
    bindEvents();
    updateHeader();
    noteVersionOnBoot();
    applyWakeLock();
    registerServiceWorker();

    setInterval(tick, 1000);
    setInterval(() => {
      if (document.visibilityState === "visible") checkForUpdates(false);
    }, UPDATE_CHECK_MS);
    setTimeout(checkDue, 400);
    setTimeout(() => checkForUpdates(false), 2500);
    setTimeout(tick, 250);

    try {
      handleLaunchAction(new URLSearchParams(location.search));
    } catch (e) {}

    if (firstRun) {
      setTimeout(() => toast("Welcome! Your default workday schedule is ready."), 700);
    } else if (isPaused()) {
      setTimeout(() => toast("Do Not Disturb is on — reminders are paused."), 700);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* Keep the app testable from the console / automated tests. */
  window.WorkReminder = {
    get state() { return state; },
    get updateInfo() { return updateInfo; },
    get whatsNewInfo() { return whatsNewInfo; },
    save, renderAll, checkDue, remIsDue,
    markDone, snoozeReminder, showView,
    checkForUpdates, applyUpdate, openWhatsNew, renderUpdateUI,
    version: APP.version,
  };
})();
