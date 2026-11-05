/* Work Reminder - text-to-speech engine (Web Speech API).
   Picks a natural voice that matches the requested language and gender.

   Mobile is the hard part: Android often exposes voices with no gender in the
   name, iPhone populates the voice list late, and both can refuse a queued
   utterance if the engine is left paused. So this engine:
     - waits for voices instead of reading an empty list once,
     - prefers a real same-gender voice when the phone names one,
     - otherwise speaks with the closest voice and tunes pitch, instead of
       failing with "no male voice installed",
     - primes the engine on the first tap so later reminders can speak. */
(function () {
  "use strict";

  const LANGS = { en: ["en"], ne: ["ne", "en-IN", "hi", "en"], hi: ["hi", "en-IN", "en"] };
  const FEMALE_HINTS = ["female", "zira", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "veena", "aditi", "ava", "susan", "kate", "emily", "serena", "heera", "lekha", "aria", "jenny", "hazel", "allison", "ariaonline", "eva", "paulina", "amelie", "denise", "joanna", "kimberly", "salli", "amy", "raveena", "priya", "kalpana", "neerja", "zhiyu", "huihui", "yaoyao", "zoe", "nicky", "martha", "sonia", "lucia", "camila", "valentina", "sofia", "isabella", "gabriela", "mia", "ella", "olivia", "marisol"];
  const MALE_HINTS = ["male", "david", "daniel", "mark", "alex", "fred", "thomas", "rishi", "ravi", "hemant", "george", "james", "roger", "guy", "ryan", "davis", "christopher", "brian", "neil", "arthur", "arun", "madhur", "valluvar", "jian", "kangkang", "yunyang", "aaron", "adam", "gordon", "tom", "oliver", "liam", "steffan", "antonio", "diego", "jorge", "mike", "henry", "tony", "bob", "maged", "tarik", "yuri", "dmitri", "pavel"];
  /* Curated male voices known to sound natural. Matching a good voice by name
     matters more than the raw voice-list order, which is arbitrary and often
     starts with a low-quality compact voice. */
  const MALE_PREMIUM = /alex|daniel|arthur|aaron|fred|tom|oliver|rishi|hemant|guy|andrew|brian|christopher|davis|eric|steffan|roger|google uk english male|google us english male/;
  const MALE_STANDARD = /david|mark|james|george|ryan|thomas|ravi|arun|madhur|jian|liam|tony|henry|mike|bob|adam|gordon|maged|tarik|yuri|dmitri|pavel/;
  const SETTLE_MS = 90;
  function isMobile() { return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ""); }
  function isAndroid() { return /Android/i.test(navigator.userAgent || ""); }

  let voicesCache = null;
  let voicesSource = null;
  let lastStartAt = 0;
  let unlocked = false;
  let currentUtterance = null;
  let voicesBound = false;

  function synth() {
    try { return window.speechSynthesis || null; } catch (e) { return null; }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function voices() {
    const s = synth();
    if (!s) return [];
    // If the engine object changes, old cached voices no longer apply.
    if (s !== voicesSource) {
      voicesSource = s;
      voicesCache = null;
    }
    try {
      const list = s.getVoices() || [];
      if (list.length) voicesCache = list;
      return list.length ? list : (voicesCache || []);
    } catch (e) {
      return voicesCache || [];
    }
  }

  /* Keep the cached list fresh. Safe to call repeatedly. */
  function bindVoicesChanged() {
    if (voicesBound) return;
    const s = synth();
    if (!s) return;
    voicesBound = true;
    try {
      s.addEventListener("voiceschanged", () => { voices(); });
    } catch (e) {
      try {
        const prev = s.onvoiceschanged;
        s.onvoiceschanged = function () {
          try { if (typeof prev === "function") prev(); } catch (e1) {}
          voices();
        };
      } catch (e2) {}
    }
    voices();
  }

  /* Resolve with whatever voices are available now, or as soon as the browser
     publishes them (iPhone and Android both do this after page load). */
  function awaitVoices(timeoutMs) {
    bindVoicesChanged();
    const limit = Math.max(300, timeoutMs || 2600);
    return new Promise((resolve) => {
      const s = synth();
      let done = false;
      let poll = null;
      let timer = null;

      const handler = () => {
        if (voices().length) finish();
      };
      const finish = () => {
        if (done) return;
        done = true;
        if (poll) clearInterval(poll);
        if (timer) clearTimeout(timer);
        if (s) {
          try { s.removeEventListener("voiceschanged", handler); } catch (e) {
            try { if (s.onvoiceschanged === handler) s.onvoiceschanged = null; } catch (e2) {}
          }
        }
        resolve(voices());
      };

      if (voices().length) return finish();
      if (!s) return finish();

      try { s.addEventListener("voiceschanged", handler); } catch (e) {
        try { s.onvoiceschanged = handler; } catch (e2) {}
      }
      poll = setInterval(() => { if (voices().length) finish(); }, 120);
      timer = setTimeout(finish, limit);
    });
  }

  /* Name and URI both matter: iPhone puts the voice name in voiceURI
     ("com.apple.voice.compact.en-US.Samantha"), Android usually does not. */
  function voiceKey(v) {
    if (!v) return "";
    return String(v.name || "") + " " + String(v.voiceURI || "");
  }

  function voiceGenderOf(v) {
    const n = (typeof v === "string" ? v : voiceKey(v)).toLowerCase();
    if (!n) return null;
    try {
      if (typeof WR !== "undefined" && WR.detectVoiceGender) {
        const g = WR.detectVoiceGender(n);
        if (g) return g;
      }
    } catch (e) {}
    if (FEMALE_HINTS.some((h) => n.indexOf(h) >= 0)) return "female";
    if (MALE_HINTS.some((h) => n.indexOf(h) >= 0)) return "male";
    return null;
  }

  function voiceScore(v, gender) {
    const n = voiceKey(v).toLowerCase();
    const g = voiceGenderOf(v);
    let s = 0;
    // Quality first: natural/neural voices sound markedly better than the
    // compact voices most phones list first.
    if (n.includes("natural")) s += 18;
    if (n.includes("neural")) s += 16;
    if (n.includes("enhanced") || n.includes("premium")) s += 8;
    if (n.includes("google")) s += 3;
    // A local voice starts instantly and works offline, so it edges out an
    // otherwise equal network voice.
    s += v.localService ? 10 : 2;
    // A genuine match in the requested gender always wins.
    if (gender && g === gender) s += 40;
    else if (gender && g && g !== gender) s -= 30;
    if (gender === "male" && MALE_PREMIUM.test(n)) s += 14;
    if (gender === "male" && MALE_STANDARD.test(n)) s += 6;
    if (gender === "female" && /aria|jenny|zira|samantha|ava|susan|amy|sonia|karen|moira|tessa|victoria|serena|olivia|mia|ella/.test(n)) s += 10;
    return s;
  }

  function bestOf(pool, gender) {
    const sorted = pool.slice().sort((a, b) => voiceScore(b, gender) - voiceScore(a, gender));
    return sorted[0] || null;
  }

  function makePicked(voice, wantG) {
    const matched = wantG ? voiceGenderOf(voice) === wantG : true;
    return { voice, matched, approximate: !!wantG && !matched, local: !!voice.localService };
  }

  function pickFromPool(pool, wantG) {
    if (!pool.length) return null;
    // When the phone names a voice of the requested gender, that voice is
    // always the best answer. Otherwise fall back to the highest-quality
    // available voice and approximate the gender with pitch.
    if (wantG) {
      const exact = pool.filter((v) => voiceGenderOf(v) === wantG);
      if (exact.length) return makePicked(bestOf(exact, wantG), wantG);
    }
    return makePicked(bestOf(pool, wantG), wantG);
  }

  function findPreferred(list, preferred) {
    if (!preferred) return null;
    const p = String(preferred).trim().toLowerCase();
    if (!p) return null;
    return list.find((v) =>
      String(v.voiceURI || "").toLowerCase() === p || String(v.name || "").toLowerCase() === p
    ) || null;
  }

  /* Never returns null while the phone has at least one voice. `matched` says
     whether the chosen voice is genuinely the requested gender; when false the
     caller lowers/raises pitch to approximate it. `preferred` pins the exact
     voice the user chose, so the same voice speaks every reminder. */
  function pickVoice(language, gender, preferred) {
    const vs = voices().filter((v) => v && v.lang);
    const wantG = (gender === "female" || gender === "male") ? gender : null;
    if (!vs.length) return null;

    const pinned = findPreferred(vs, preferred);
    if (pinned) return makePicked(pinned, wantG);

    // On mobile, search ALL voices (every language) for a genuine male voice
    // first. Android often has a male voice under a different locale than the
    // requested language, and the normal language filter would miss it.
    if (isMobile() && wantG === "male") {
      const maleVoices = vs.filter((v) => voiceGenderOf(v) === "male");
      if (maleVoices.length) {
        return makePicked(bestOf(maleVoices, "male"), "male");
      }
    }

    const prefs = LANGS[language] || (language && language !== "system" ? [language, "en"] : ["en"]);
    for (const p of prefs) {
      const pool = vs.filter((v) => String(v.lang).toLowerCase().startsWith(String(p).toLowerCase()));
      const picked = pickFromPool(pool, wantG);
      if (picked) return picked;
    }

    return pickFromPool(vs, wantG);
  }

  /* The next-best voice of the requested gender. Used only when the selected
     voice itself refuses to synthesize, so quality stays high instead of
     dropping straight to an unlabelled default. */
  function alternativeVoice(language, gender, exclude) {
    const wantG = (gender === "female" || gender === "male") ? gender : null;
    const skip = exclude ? voiceKey(exclude).toLowerCase() : "";
    const vs = voices().filter((v) => v && v.lang && voiceKey(v).toLowerCase() !== skip);
    if (!wantG || !vs.length) return null;

    const exact = vs.filter((v) => voiceGenderOf(v) === wantG);
    if (!exact.length) return null;
    const prefs = LANGS[language] || (language && language !== "system" ? [language, "en"] : ["en"]);
    for (const p of prefs) {
      const pool = exact.filter((v) => String(v.lang).toLowerCase().startsWith(String(p).toLowerCase()));
      if (pool.length) return makePicked(bestOf(pool, wantG), wantG);
    }
    return makePicked(bestOf(exact, wantG), wantG);
  }

  function normalize(text) {
    try {
      if (typeof WR !== "undefined" && WR.normalizeSpeechText) return WR.normalizeSpeechText(text);
    } catch (e) {}
    return String(text == null ? "" : text).trim();
  }

  function normalizeVolume(value) {
    const vol = Number(value);
    return isFinite(vol) ? Math.min(1, Math.max(0, vol / 100)) : 0.8;
  }

  /* Approximate a missing gender with pitch. A real male voice is left alone -
     lowering its pitch made good voices sound slow and muffled. Only voices of
     the wrong or unknown gender are shifted, and as little as still reads male. */
  function pitchFor(gender, picked) {
    if (gender !== "male" && gender !== "female") return 1.0;
    if (gender === "male") {
      if (picked.matched) return 1.0;
      const base = voiceGenderOf(picked.voice);
      return base === "female" ? 0.64 : 0.72;
    }
    if (picked.matched) return 1.0;
    return voiceGenderOf(picked.voice) === "male" ? 1.18 : 1.1;
  }

  function normalizeLang(value) {
    const lang = String(value || "").replace(/_/g, "-").trim();
    return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang) ? lang : "en-US";
  }

  /* One speak attempt. Resolves as soon as speech starts, or with a reason if
     the phone's engine refuses before starting. */
  function attemptSpeak(s, spoken, settings) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(spoken);
      if (settings.voice) u.voice = settings.voice;
      // Leave lang unset on the last-ditch attempt: the phone then uses its
      // own default voice/locale, which is the combination Android accepts
      // most often.
      if (settings.lang) u.lang = normalizeLang(settings.lang);
      u.rate = Math.min(2, Math.max(0.5, settings.rate));
      u.pitch = Math.min(2, Math.max(0.1, settings.pitch));
      u.volume = settings.volume;

      currentUtterance = u;
      let settled = false;
      let timer = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        lastStartAt = Date.now();
        if (currentUtterance === u) currentUtterance = null;
        resolve(Object.assign({
          voice: settings.voice ? settings.voice.name : "phone default",
          voiceUri: settings.voice ? settings.voice.voiceURI : "",
          lang: u.lang,
          rate: u.rate,
          pitch: u.pitch,
          gender: settings.voice ? voiceGenderOf(settings.voice) : null
        }, result));
      };

      u.onstart = () => finish({ ok: true });
      u.onend = () => finish({ ok: true, ended: true });
      u.onerror = (e) => finish({ ok: false, error: (e && (e.error || e.message)) || "speech-failed" });

      timer = setTimeout(() => {
        let active = false;
        try { active = !!(s.speaking || s.pending); } catch (e) {}
        finish({ ok: active, error: active ? null : "speech-did-not-start", timedOut: true });
      }, 4000);

      try {
        s.speak(u);
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }

      // Android sometimes reports paused=true right after a previous cancel.
      setTimeout(() => {
        try { if (s.paused) s.resume(); } catch (e) {}
      }, 220);
    });
  }

  function speak(text, cfg) {
    cfg = cfg || {};
    return new Promise(async (resolve) => {
      const s = synth();
      const spoken = normalize(text);
      if (!s) return resolve({ ok: false, error: "no-speech-engine" });
      if (!spoken) return resolve({ ok: false, error: "empty text" });

      const wantG = (cfg.gender === "female" || cfg.gender === "male") ? cfg.gender : "male";
      const lang = cfg.language || "en";
      const volume = normalizeVolume(cfg.volume);

      // Stop a run that is genuinely in progress, then give Android time to
      // settle. The retry below covers the rare cancel/speak race that returns
      // "synthesis-failed".
      if (s.speaking || s.pending) {
        try { s.cancel(); } catch (e) {}
        // Wait until the old utterance really stops before starting a new one.
        for (let i = 0; i < 12; i++) {
          let busy = false;
          try { busy = !!(s.speaking || s.pending); } catch (e) {}
          if (!busy) break;
          await delay(50);
        }
        await delay(SETTLE_MS * 2);
      }
      try { s.resume(); } catch (e) {}

      // Waiting for the voice list is right for a reminder that fires on its
      // own, but wrong inside a tap: iOS drops the gesture that allows audio
      // when the call is delayed. `immediate` (used by Test voice and the
      // gender picker) speaks now and lets voices arrive for the next call.
      if (!cfg.immediate) await awaitVoices(voices().length ? 400 : 2600);

      let rate = 0.92;
      try {
        if (typeof WR !== "undefined" && WR.voiceRate) rate = WR.voiceRate(cfg.speed, wantG || "male");
      } catch (e) {}

      const picked = pickVoice(lang, wantG || "male", cfg.voiceName);
      // An explicitly chosen voice is played exactly as it is: the user picked
      // that sound, so do not "improve" it with a pitch shift.
      const pinnedVoice = findPreferred(voices(), cfg.voiceName);
      const fallbackPitch = wantG === "male" ? 0.78 : wantG === "female" ? 1.08 : 1.0;
      const baseLang = (typeof WR !== "undefined" && WR.ttsLang ? WR.ttsLang(lang) : "en-US") || "en-US";

      const attempts = [];
      // On mobile the engine often ignores the voice object and speaks with the
      // default voice for the locale. Try several locales that commonly resolve
      // to a male voice on phones, so a clean male voice is used when available.
      if (isMobile() && wantG === "male") {
        attempts.push({ voice: null, lang: "en-GB", rate, pitch: 1.0, phoneDefault: true });
        attempts.push({ voice: null, lang: "en-AU", rate, pitch: 1.0, phoneDefault: true });
        attempts.push({ voice: null, lang: "en-IN", rate, pitch: 1.0, phoneDefault: true });
      }
      if (picked && picked.voice) {
        attempts.push({
          voice: picked.voice,
          lang: picked.voice.lang || baseLang,
          rate,
          pitch: pinnedVoice ? 1.0 : pitchFor(wantG, picked)
        });

        // A second real voice of the same gender keeps quality up if the first
        // choice is a network voice that cannot synthesize right now.
        const alt = wantG ? alternativeVoice(lang, wantG, picked.voice) : null;
        if (alt) {
          attempts.push({
            voice: alt.voice,
            lang: alt.voice.lang || baseLang,
            rate,
            pitch: pitchFor(wantG, alt)
          });
        }
        if (wantG === "male" && picked && !picked.matched && !isMobile()) {
          attempts.push({ voice: null, lang: "en-GB", rate, pitch: 1.0, phoneDefault: true });
        }
      } else if (wantG === "male" && !isMobile()) {
        // No voice has been published yet (common on iOS until the engine has
        // spoken once). en-GB is usually a genuine male voice there, and
        // Android falls through to its own default below.
        attempts.push({ voice: null, lang: "en-GB", rate, pitch: 1.0, phoneDefault: true });
      }

      // Android's safest path: no explicit voice and no forced locale, just
      // the phone's own default engine. This also means an empty voice list is
      // never a hard failure - the phone can still speak.
      attempts.push({ voice: null, lang: null, rate, pitch: fallbackPitch, phoneDefault: true });

      let last = null;
      for (let i = 0; i < attempts.length; i++) {
        if (i > 0) {
          try { s.cancel(); } catch (e) {}
          await delay(SETTLE_MS * 4);
          try { s.resume(); } catch (e) {}
        }
        const attempt = Object.assign({ volume }, attempts[i]);
        const res = await attemptSpeak(s, spoken, attempt);
        if (res.ok) {
          const chosen = picked && picked.voice ? picked.voice : null;
          return resolve(Object.assign({}, res, {
            selectedVoice: chosen ? chosen.name : "phone default",
            selectedVoiceUri: chosen ? chosen.voiceURI : "",
            matched: chosen ? !!picked.matched : false,
            approximate: chosen ? (!!wantG && !picked.matched) : !!wantG,
            genderMatched: chosen ? (!wantG || !!picked.matched) : false,
            pinned: !!pinnedVoice,
            fallback: i > 0,
            attempt: i + 1,
            voiceCount: voices().length
          }));
        }
        last = res;
        // These will not improve by retrying.
        if (res.error === "not-allowed" || res.error === "empty text") break;
      }

      const failedVoice = picked && picked.voice ? picked.voice : null;
      resolve({
        ok: false,
        error: (last && last.error) || "speech-failed",
        voice: failedVoice ? failedVoice.name : "phone default",
        selectedVoice: failedVoice ? failedVoice.name : "phone default",
        tries: attempts.length,
        voiceCount: voices().length
      });
    });
  }

  function stop() {
    const s = synth();
    if (!s) return;
    try { s.cancel(); } catch (e) {}
    currentUtterance = null;
  }

  function isSpeaking() {
    const s = synth();
    try { return !!(s && (s.speaking || (s.pending && Date.now() - lastStartAt < 1500))); } catch (e) { return false; }
  }

  /* Browsers that require a gesture (iOS Safari, Chrome Android) keep the
     engine paused until one. Just resume it here. Speaking a silent utterance
     to "prime" the engine can leave Android in a failed state, and the real
     Test voice call is already inside a gesture, so it needs no primer. */
  function unlock() {
    const s = synth();
    if (!s) return false;
    try { s.resume(); } catch (e) {}
    unlocked = true;
    bindVoicesChanged();
    return true;
  }

  function listVoices() {
    const raw = voices();
    const vs = raw.map((v) => ({
      name: v.name,
      uri: v.voiceURI,
      lang: v.lang,
      local: !!v.localService,
      gender: voiceGenderOf(v),
      quality: voiceScore(v, null),
      maleRank: voiceScore(v, "male")
    }));
    const bestMale = bestOf(raw.filter((v) => voiceGenderOf(v) === "male"), "male");
    const bestFemale = bestOf(raw.filter((v) => voiceGenderOf(v) === "female"), "female");
    const bestKey = bestMale ? voiceKey(bestMale).toLowerCase() : "";
    const bestFKey = bestFemale ? voiceKey(bestFemale).toLowerCase() : "";
    vs.forEach((v) => {
      const key = (voiceKey({ name: v.name, voiceURI: v.uri }) || "").toLowerCase();
      v.recommendedMale = !!bestKey && key === bestKey;
      v.recommendedFemale = !!bestFKey && key === bestFKey;
    });
    const male = vs.filter((v) => v.gender === "male").sort((a, b) => b.maleRank - a.maleRank);
    return {
      ok: true,
      count: vs.length,
      voices: vs.slice(0, 160),
      male: male.slice(0, 40),
      bestMale: bestMale ? { name: bestMale.name, uri: bestMale.voiceURI, lang: bestMale.lang, local: !!bestMale.localService } : null,
      bestFemale: bestFemale ? { name: bestFemale.name, uri: bestFemale.voiceURI, lang: bestFemale.lang, local: !!bestFemale.localService } : null
    };
  }

  bindVoicesChanged();

  if (typeof window !== "undefined" && window.addEventListener) {
    const primed = () => { unlock(); };
    ["pointerdown", "touchstart", "keydown"].forEach((evt) => {
      try {
        window.addEventListener(evt, primed, { once: true, passive: true });
      } catch (e) {
        try { window.addEventListener(evt, primed, false); } catch (e2) {}
      }
    });
  }

  window.VoiceEngine = {
    speak, stop, isSpeaking, listVoices, awaitVoices, voiceGenderOf, unlock,
    selectVoice: pickVoice, getVoices: voices
  };
})();
