/* Work Reminder — WebAudio chime engine.
   Generates all reminder sounds live (no audio asset files). Mobile browsers
   only allow audio after a user gesture, so unlock() is called from the first
   tap and every preview/alert resumes the context if the OS suspended it. */
(function () {
  "use strict";

  let audioCtx = null;
  let masterBus = null;
  let activeSound = null;
  let unlocked = false;

  function ctx() {
    if (!audioCtx) {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        audioCtx = new C();
      } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === "suspended") {
      try { audioCtx.resume().catch(() => {}); } catch (e) {}
    }
    return audioCtx;
  }

  /* Must be called from a trusted user gesture (tap/click/keydown). Playing a
     one-frame silent buffer unlocks WebAudio on iOS Safari as well. */
  async function unlock() {
    const c = ctx();
    if (!c) return false;
    try {
      if (c.state === "suspended") await c.resume();
    } catch (e) {}
    try {
      const b = c.createBuffer(1, 1, c.sampleRate || 44100);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch (e) {}
    unlocked = c.state === "running";
    return unlocked;
  }

  function isUnlocked() {
    return !!(audioCtx && audioCtx.state === "running") || unlocked;
  }

  function bus() {
    const c = ctx(); if (!c) return null;
    if (!masterBus) {
      masterBus = c.createGain();
      masterBus.gain.value = 1;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -2;
      comp.knee.value = 4;
      comp.ratio.value = 12;
      comp.attack.value = 0.002;
      comp.release.value = 0.22;
      masterBus.connect(comp).connect(c.destination);
    }
    return masterBus;
  }

  /* Fade and disconnect the current alert. Used by DND, by the stop button and
     before a new preview so sounds never stack. */
  function stop() {
    const group = activeSound;
    activeSound = null;
    if (!group) return;
    try {
      const c = ctx();
      if (c) {
        const t = c.currentTime;
        const level = Math.max(0.0001, +group.gain.value || 0.0001);
        group.gain.cancelScheduledValues(t);
        group.gain.setValueAtTime(level, t);
        group.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
      }
    } catch (e) {}
    setTimeout(() => { try { group.disconnect(); } catch (e) {} }, 80);
  }

  const HARMONIC = [[1, 1], [2, 0.16], [3, 0.06]];

  /* One expressive voice: smooth attack/decay, lowpass to tame harshness,
     stereo placement for width, additive partials for body. */
  function note(o) {
    const c = ctx(); const out = bus();
    if (!c || !out) return;
    const t0 = c.currentTime + (o.start || 0);
    const dur = Math.max(0.05, o.dur == null ? 0.2 : o.dur);
    const vol = Math.max(0.0002, o.vol == null ? 0.5 : o.vol);
    const atk = o.attack == null ? 0.012 : o.attack;
    const rel = o.release == null ? dur : o.release;
    const type = o.type || "sine";

    const env = c.createGain();
    env.gain.setValueAtTime(0.0002, t0);
    env.gain.linearRampToValueAtTime(vol, t0 + atk);
    env.gain.exponentialRampToValueAtTime(0.0004, t0 + atk + rel);

    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(o.filter || 6800, t0);
    lp.Q.value = 0.0006;

    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.max(-1, Math.min(1, o.pan || 0));

    if (pan) { env.connect(lp); lp.connect(pan); pan.connect(activeSound || out); }
    else { env.connect(lp); lp.connect(activeSound || out); }

    const partials = o.partials || HARMONIC;
    partials.forEach((p, i) => {
      const mult = p[0], amp = p[1];
      const osc = c.createOscillator();
      osc.type = type;
      const f = (o.freq || 440) * mult;
      osc.frequency.setValueAtTime(Math.max(1, f), t0);
      if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.glide * mult), t0 + atk + rel);
      if (o.detune) osc.detune.setValueAtTime(o.detune * (i % 2 ? 1 : -1), t0);
      const g = c.createGain();
      g.gain.value = amp;
      osc.connect(g); g.connect(env);
      osc.start(t0);
      osc.stop(t0 + atk + rel + 0.08);
    });
  }

  function play(name, volume) {
    if (!name || name === "none") return false;
    const n = Number(volume);
    const v = isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0.8;
    if (v <= 0) return false;
    const c = ctx();
    const out = bus();
    if (!c || !out) return false;
    if (c.state === "suspended") {
      try { c.resume().catch(() => {}); } catch (e) {}
    }
    stop();
    const group = c.createGain();
    group.gain.value = 1;
    group.connect(out);
    activeSound = group;

    // Let the group go after the longest pattern finishes.
    setTimeout(() => {
      if (activeSound !== group) return;
      activeSound = null;
      try { group.disconnect(); } catch (e) {}
    }, 6000);

    const d = 0.18; // short, punchy note length
    switch (name) {
      case "soft":
        note({ freq: 659.25, start: 0, dur: d * 2.4, type: "sine", vol: v * 0.42, attack: 0.03, pan: -0.12 });
        note({ freq: 987.77, start: d * 1.3, dur: d * 2.6, type: "sine", vol: v * 0.36, attack: 0.03, pan: 0.12 });
        break;
      case "bell":
        note({ freq: 1318.5, start: 0, dur: d * 3, type: "sine", vol: v * 0.5, filter: 9000, release: d * 3, partials: [[1, 1], [2.76, 0.35], [5.4, 0.14]] });
        note({ freq: 1760, start: d * 0.8, dur: d * 3, type: "sine", vol: v * 0.3, filter: 9000, release: d * 3, partials: [[1, 1], [2.76, 0.3]] });
        break;
      case "glass":
        note({ freq: 1567.98, start: 0, dur: d * 3.4, type: "sine", vol: v * 0.42, filter: 11000, release: d * 3.4, partials: [[1, 1], [2, 0.22], [3, 0.08]] });
        note({ freq: 2093, start: d * 0.7, dur: d * 3.4, type: "sine", vol: v * 0.3, filter: 12000, release: d * 3.2, partials: [[1, 1], [2, 0.18]] });
        break;
      case "gentle":
        note({ freq: 392, start: 0, dur: d * 3.2, type: "sine", vol: v * 0.4, attack: 0.06, pan: -0.1 });
        note({ freq: 523.25, start: d * 1.3, dur: d * 3.4, type: "sine", vol: v * 0.4, attack: 0.06, pan: 0.1 });
        break;
      case "digital":
        note({ freq: 880, start: 0, dur: d, type: "triangle", vol: v * 0.42, filter: 5200, partials: [[1, 1], [3, 0.12]] });
        note({ freq: 1174.66, start: d * 0.75, dur: d, type: "triangle", vol: v * 0.42, filter: 5200, partials: [[1, 1], [3, 0.12]] });
        note({ freq: 1567.98, start: d * 1.5, dur: d * 1.4, type: "triangle", vol: v * 0.4, filter: 5600, partials: [[1, 1], [2, 0.14]] });
        break;
      case "cascade":
        note({ freq: 1318.5, start: 0, dur: d * 1.3, type: "sine", vol: v * 0.42, pan: 0.18 });
        note({ freq: 1046.5, start: d * 0.7, dur: d * 1.3, type: "sine", vol: v * 0.4, pan: 0 });
        note({ freq: 783.99, start: d * 1.4, dur: d * 1.8, type: "sine", vol: v * 0.4, pan: -0.18 });
        break;
      case "sunrise":
        note({ freq: 261.63, start: 0, dur: d * 3.6, type: "sine", vol: v * 0.36, attack: 0.12, pan: -0.16, partials: [[1, 1], [2, 0.14], [3, 0.05]] });
        note({ freq: 329.63, start: d * 1.0, dur: d * 3.6, type: "sine", vol: v * 0.36, attack: 0.12, pan: 0 });
        note({ freq: 392.0, start: d * 2.0, dur: d * 3.8, type: "sine", vol: v * 0.4, attack: 0.14, pan: 0.16 });
        note({ freq: 523.25, start: d * 3.0, dur: d * 4, type: "sine", vol: v * 0.3, attack: 0.16, pan: 0.1 });
        break;
      case "melody":
        note({ freq: 659.25, start: 0, dur: d * 1.5, type: "triangle", vol: v * 0.4, filter: 6000, pan: -0.08, partials: [[1, 1], [4, 0.14]] });
        note({ freq: 783.99, start: d * 0.85, dur: d * 1.5, type: "triangle", vol: v * 0.4, filter: 6200, pan: -0.04, partials: [[1, 1], [4, 0.14]] });
        note({ freq: 1046.5, start: d * 1.7, dur: d * 2.6, type: "triangle", vol: v * 0.38, filter: 6400, pan: 0.08, partials: [[1, 1], [3, 0.12]] });
        note({ freq: 783.99, start: d * 3.0, dur: d * 2.2, type: "triangle", vol: v * 0.32, filter: 6000, pan: 0.12, partials: [[1, 1], [3, 0.12]] });
        break;
      case "pop":
        note({ freq: 660, start: 0, dur: d * 0.9, type: "sine", vol: v * 0.5, filter: 5600, attack: 0.006, glide: 520, partials: [[1, 1]] });
        note({ freq: 990, start: d * 0.7, dur: d * 1.1, type: "sine", vol: v * 0.45, filter: 6000, partials: [[1, 1], [2, 0.18]] });
        break;
      case "zen":
        note({ freq: 220.0, start: 0, dur: d * 4.6, type: "sine", vol: v * 0.42, attack: 0.18, release: d * 4.6, detune: 4, pan: -0.1, partials: [[1, 1], [2.76, 0.22], [4.1, 0.1]] });
        note({ freq: 330.0, start: d * 0.6, dur: d * 4.4, type: "sine", vol: v * 0.26, attack: 0.2, release: d * 4.4, pan: 0.12 });
        break;
      case "sparkle":
        note({ freq: 1046.5, start: 0, dur: d * 0.9, type: "sine", vol: v * 0.34, filter: 11000, pan: -0.2 });
        note({ freq: 1174.66, start: d * 0.45, dur: d * 0.9, type: "sine", vol: v * 0.34, filter: 11000, pan: -0.06 });
        note({ freq: 1318.5, start: d * 0.9, dur: d * 0.9, type: "sine", vol: v * 0.34, filter: 12000, pan: 0.06 });
        note({ freq: 1567.98, start: d * 1.35, dur: d * 1.7, type: "sine", vol: v * 0.32, filter: 13000, pan: 0.2 });
        break;
      case "alarm":
        for (let i = 0; i < 4; i++) {
          note({ freq: i % 2 ? 740 : 988, start: i * d * 0.85, dur: d * 0.7, type: "triangle", vol: v * 0.4, filter: 4200, attack: 0.006, partials: [[1, 1], [2, 0.4]] });
        }
        break;
      default:
        // Full, warm two-note bell (D5 -> A5): soft mallet attack, rich
        // harmonic body and a short sub-octave so it carries on phone
        // speakers. Three gently decaying strikes ring for about three seconds.
        const strike = (start, gain) => {
          note({ freq: 587.33, start, dur: 0.72, type: "sine", vol: v * 0.90 * gain, attack: 0.004, release: 0.72, filter: 5200, pan: -0.04, partials: [[1, 1], [2, 0.34], [3, 0.16], [4, 0.07]] });
          note({ freq: 293.66, start, dur: 0.42, type: "sine", vol: v * 0.34 * gain, attack: 0.008, release: 0.42, filter: 1500, partials: [[1, 1]] });
          note({ freq: 880, start: start + 0.13, dur: 0.9, type: "sine", vol: v * 0.82 * gain, attack: 0.004, release: 0.9, filter: 5600, pan: 0.04, partials: [[1, 1], [2, 0.30], [3, 0.14], [4, 0.06]] });
        };
        strike(0, 1);
        strike(0.95, 0.72);
        strike(1.9, 0.52);
    }
    return true;
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx && audioCtx.state === "suspended") {
      try { audioCtx.resume().catch(() => {}); } catch (e) {}
    }
  });

  window.SoundEngine = { unlock, isUnlocked, play, stop };
})();
