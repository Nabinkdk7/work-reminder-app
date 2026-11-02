/* Work Reminder — text-to-speech engine (Web Speech API).
   Picks a natural voice that matches the requested language and gender,
   normalizes the spoken copy and never substitutes the opposite gender. */
(function () {
  "use strict";

  const LANGS = { en: ["en"], ne: ["ne"], hi: ["hi", "en-IN", "en"] };
  const FEMALE_HINTS = ["female", "zira", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "veena", "aditi", "ava", "susan", "kate", "emily", "serena", "heera", "lekha", "aria", "jenny", "hazel", "allison", "ariaonline", "eva", "paulina", "amelie", "denise", "joanna", "kimberly", "salli", "amy", "raveena", "priya", "kalpana", "neerja", "zhiyu", "huihui", "yaoyao"];
  const MALE_HINTS = ["male", "david", "daniel", "mark", "alex", "fred", "thomas", "rishi", "ravi", "hemant", "george", "james", "roger", "guy", "ryan", "davis", "christopher", "brian", "neil", "arthur", "arun", "madhur", "valluvar", "jian", "kangkang", "yunyang"];

  let voicesCache = null;
  let lastStartAt = 0;

  function synth() {
    try { return window.speechSynthesis || null; } catch (e) { return null; }
  }

  function voices() {
    const s = synth();
    if (!s) return [];
    try {
      const vs = s.getVoices() || [];
      if (vs.length) voicesCache = vs;
      return vs.length ? vs : (voicesCache || []);
    } catch (e) { return voicesCache || []; }
  }

  function awaitVoices(timeoutMs) {
    return new Promise((resolve) => {
      if (voices().length) return resolve(voices());
      const s = synth();
      if (!s) return resolve([]);
      let done = false;
      let handler = null;
      let prev = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try {
          if (handler && s.onvoiceschanged === handler) s.onvoiceschanged = prev;
        } catch (e) {}
        resolve(voices());
      };
      const t = setTimeout(finish, timeoutMs || 2000);
      try {
        prev = s.onvoiceschanged;
        handler = () => {
          try { if (typeof prev === "function") prev(); } catch (e) {}
          finish();
        };
        s.onvoiceschanged = handler;
      } catch (e) { clearTimeout(t); finish(); }
    });
  }

  function voiceGenderOf(v) {
    try {
      if (typeof WR !== "undefined" && WR.detectVoiceGender) {
        const g = WR.detectVoiceGender(v && v.name);
        if (g) return g;
      }
    } catch (e) {}
    const n = String((v && v.name) || "").toLowerCase();
    if (FEMALE_HINTS.some((h) => n.indexOf(h) >= 0)) return "female";
    if (MALE_HINTS.some((h) => n.indexOf(h) >= 0) && !FEMALE_HINTS.some((h) => n.indexOf(h) >= 0)) return "male";
    return null;
  }

  function voiceScore(v, gender) {
    const n = (v.name || "").toLowerCase();
    let s = 0;
    if (!v.localService) s += 10; // network voices usually sound cleaner
    if (n.includes("natural")) s += 6;
    if (n.includes("neural")) s += 5;
    if (n.includes("google")) s += 4;
    if (n.includes("enhanced") || n.includes("premium")) s += 3;
    if (n.includes("online")) s += 2;
    if (gender === "male") {
      if (n.includes("male")) s += 4;
      if (/david|george|ravi|rishi|hemant|guy|james/.test(n)) s += 2;
    }
    if (gender === "female") {
      if (n.includes("female")) s += 4;
      if (/aria|jenny|zira|samantha|ava|susan|amy|sonia/.test(n)) s += 2;
    }
    return s;
  }

  function pickVoice(language, gender) {
    const vs = voices();
    const prefs = LANGS[language] || (language ? [language, "en"] : ["en"]);
    const wantG = (gender === "female" || gender === "male") ? gender : null;
    for (const p of prefs) {
      const match = vs.filter((v) => v.lang && String(v.lang).toLowerCase().startsWith(String(p).toLowerCase()));
      if (!match.length) continue;
      if (!wantG) {
        match.sort((a, b) => voiceScore(b, null) - voiceScore(a, null));
        return match[0];
      }
      const pool = match.filter((v) => voiceGenderOf(v) === wantG);
      if (!pool.length) continue;
      pool.sort((a, b) => voiceScore(b, wantG) - voiceScore(a, wantG));
      return pool[0];
    }
    if (wantG) {
      const crossLang = vs.filter((v) => voiceGenderOf(v) === wantG);
      if (crossLang.length) {
        crossLang.sort((a, b) => voiceScore(b, wantG) - voiceScore(a, wantG));
        return crossLang[0];
      }
      return null;
    }
    return null;
  }

  function normalize(text) {
    try {
      if (typeof WR !== "undefined" && WR.normalizeSpeechText) return WR.normalizeSpeechText(text);
    } catch (e) {}
    return String(text == null ? "" : text).trim();
  }

  function speak(text, cfg) {
    cfg = cfg || {};
    return new Promise(async (resolve) => {
      const s = synth();
      const spoken = normalize(text);
      if (!s) return resolve({ ok: false, error: "no-speech-engine" });
      if (!spoken) return resolve({ ok: false, error: "empty text" });

      try { s.cancel(); } catch (e) {}
      await awaitVoices(1800);

      const wantG = (cfg.gender === "female" || cfg.gender === "male") ? cfg.gender : null;
      const lang = cfg.language || "en";
      let v = pickVoice(lang, cfg.gender || "default");
      if (!v) v = pickVoice("en", cfg.gender || "default");
      if (!v && wantG) return resolve({ ok: false, error: "no-voice-for-gender", gender: cfg.gender });
      if (!v) {
        v = voices()[0] || null;
        if (!v) return resolve({ ok: false, error: "no-voices" });
      }

      let rate = 0.86, pitch = 1.0;
      try {
        if (typeof WR !== "undefined") {
          rate = WR.voiceRate(cfg.speed, cfg.gender || "default");
          pitch = WR.voicePitch(cfg.gender || "default");
        }
      } catch (e) {}
      const vol = Number(cfg.volume);
      const volume = isFinite(vol) ? Math.min(1, Math.max(0, vol / 100)) : 0.8;

      const u = new SpeechSynthesisUtterance(spoken);
      u.voice = v;
      u.lang = v.lang || "en-US";
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lastStartAt = Date.now();
        resolve(result);
      };
      // Resolve when speech actually starts; a browser that silently refuses
      // (common on iOS without a fresh gesture) times out instead of hanging.
      u.onstart = () => finish({ ok: true, voice: v.name, genderMatched: !wantG || voiceGenderOf(v) === wantG });
      u.onerror = (e) => finish({ ok: false, error: (e && (e.error || e.message)) || "speech-failed" });
      const timer = setTimeout(() => finish({ ok: true, voice: v.name, genderMatched: !wantG || voiceGenderOf(v) === wantG, timedOut: true }), 3000);

      try {
        s.speak(u);
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function stop() {
    const s = synth();
    if (!s) return;
    try { s.cancel(); } catch (e) {}
  }

  function isSpeaking() {
    const s = synth();
    try { return !!(s && (s.speaking || (s.pending && Date.now() - lastStartAt < 1500))); } catch (e) { return false; }
  }

  function listVoices() {
    const vs = voices().map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
    return { ok: true, count: vs.length, voices: vs.slice(0, 80) };
  }

  const s = synth();
  if (s) {
    try {
      s.onvoiceschanged = () => { voices(); };
      voices();
    } catch (e) {}
  }

  window.VoiceEngine = { speak, stop, isSpeaking, listVoices, awaitVoices, voiceGenderOf };
})();
