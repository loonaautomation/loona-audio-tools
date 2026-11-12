/* Loona Audio Tools - expansion DSP helpers (pack P11d + expansion order):
   silence trimming, channel conversion, BPM/tempo detection and waveform
   peaks. Pure functions only (no DOM access) so they can be unit-tested
   in Node. In the browser this attaches window.LoonaAudioExpansion; in
   Node it uses module.exports. */
(function (global) {
  'use strict';

  /* ---------- Silence trimming ---------- */

  /* dBFS threshold (e.g. -40) -> linear amplitude (0.01). */
  function dbToLinear(db) {
    return Math.pow(10, (Number(db) || 0) / 20);
  }

  /* Find the first and last samples whose peak across channels exceeds the
     threshold. padSec of audio is kept on each side. Returns
     {startSample, endSample, allSilence}. For an all-silent file both are 0. */
  function findSilenceBounds(channelData, sampleRate, thresholdDb, padSec) {
    var lin = dbToLinear(thresholdDb);
    var n = channelData && channelData.length ? channelData[0].length : 0;
    var first = -1, last = -1, i, c, m, v;
    for (i = 0; i < n; i++) {
      m = 0;
      for (c = 0; c < channelData.length; c++) { v = Math.abs(channelData[c][i]); if (v > m) m = v; }
      if (m > lin) { first = i; break; }
    }
    if (first < 0) return { startSample: 0, endSample: 0, allSilence: true };
    for (i = n - 1; i >= first; i--) {
      m = 0;
      for (c = 0; c < channelData.length; c++) { v = Math.abs(channelData[c][i]); if (v > m) m = v; }
      if (m > lin) { last = i; break; }
    }
    var pad = Math.max(0, Math.round((Number(padSec) || 0) * sampleRate));
    return {
      startSample: Math.max(0, first - pad),
      endSample: Math.min(n, last + 1 + pad),
      allSilence: false
    };
  }

  /* Copy the samples in [startSample, endSample) of every channel. */
  function sliceChannels(channelData, startSample, endSample) {
    return channelData.map(function (ch) { return ch.slice(startSample, endSample); });
  }

  /* ---------- Channel conversion ---------- */

  function mixToMono(channelData) {
    var n = channelData[0].length, out = new Float32Array(n), c, i;
    for (c = 0; c < channelData.length; c++) {
      var ch = channelData[c];
      for (i = 0; i < n; i++) out[i] += ch[i];
    }
    for (i = 0; i < n; i++) out[i] /= channelData.length;
    return out;
  }

  /* Convert channels according to mode:
       'mono'        -> 1 channel, the average of all input channels
       'stereo'      -> 2 channels (mono input duplicated; stereo copied;
                        more channels are mixed to mono then duplicated)
       'swap'        -> stereo channels exchanged (mono input: copy)
       'left-only'   -> first channel copied to both outputs (stereo out)
       'right-only'  -> second channel (or first if mono) copied to both
     Returns a new per-channel array set. Throws on unknown mode/empty input. */
  function convertChannels(channelData, mode) {
    if (!channelData || !channelData.length) throw new Error('אין ערוצי שמע להמרה.');
    var left = channelData[0];
    var right = channelData.length > 1 ? channelData[1] : channelData[0];
    switch (mode) {
      case 'mono':
        return [mixToMono(channelData)];
      case 'stereo':
        if (channelData.length === 2) return [left.slice(), right.slice()];
        if (channelData.length === 1) return [left.slice(), left.slice()];
        var m = mixToMono(channelData); return [m, m.slice()];
      case 'swap':
        if (channelData.length === 1) return [left.slice()];
        return [right.slice(), left.slice()];
      case 'left-only':
        return [left.slice(), left.slice()];
      case 'right-only':
        return [right.slice(), right.slice()];
      default:
        throw new Error('מצב ערוץ לא ידוע: ' + mode);
    }
  }

  /* ---------- BPM / tempo detection ---------- */

  /* Onset envelope: positive changes of short-window energy of the mono
     mix, one value per hop. Returns {env: Float32Array, fps}. */
  function onsetEnvelope(channelData, sampleRate) {
    var n = channelData[0].length;
    var mono = new Float32Array(n), i, c;
    for (i = 0; i < n; i++) {
      var s = 0;
      for (c = 0; c < channelData.length; c++) s += channelData[c][i];
      mono[i] = s / channelData.length;
    }
    var win = 1024, hop = 512;
    var frames = Math.max(0, Math.floor((n - win) / hop));
    var env = new Float32Array(frames);
    var prevE = 0;
    for (var f = 0; f < frames; f++) {
      var e = 0, off = f * hop;
      for (i = 0; i < win; i += 4) { var v = mono[off + i]; e += v * v; }
      env[f] = Math.max(0, e - prevE);
      prevE = e;
    }
    var mean = 0;
    for (i = 0; i < frames; i++) mean += env[i];
    mean /= Math.max(1, frames);
    for (i = 0; i < frames; i++) env[i] -= mean;
    return { env: env, fps: sampleRate / hop };
  }

  /* Detect tempo by a tempogram: DFT magnitudes of the onset envelope over
     40-208 BPM in 0.5 BPM steps; the strongest periodicity wins.
     confidence = best magnitude / average magnitude. Beat-less material
     scores ~1; clear beat tracks score 5+. hasClearBeat uses >= 2.5.
     Returns null when there is too little audio (< ~1 s of envelope). */
  function detectTempo(channelData, sampleRate) {
    if (!channelData || !channelData.length) return null;
    var oe = onsetEnvelope(channelData, sampleRate);
    var env = oe.env, fps = oe.fps, N = env.length;
    if (N < 20) return null;
    var best = null, sum = 0, count = 0, bpm, f;
    var scores = [];
    for (bpm = 40; bpm <= 208; bpm += 0.5) {
      var freq = bpm / 60, w = 2 * Math.PI * freq / fps, re = 0, im = 0;
      for (f = 0; f < N; f++) { re += env[f] * Math.cos(w * f); im -= env[f] * Math.sin(w * f); }
      var mag = Math.sqrt(re * re + im * im);
      scores.push(mag); sum += mag; count++;
      if (!best || mag > best.mag) best = { bpm: bpm, mag: mag };
    }
    var avg = count ? sum / count : 0;
    var confidence = avg > 0 ? best.mag / avg : 0;
    return {
      bpm: best.bpm,
      confidence: confidence,
      hasClearBeat: confidence >= 2.5,
      secondsPerBeat: 60 / best.bpm
    };
  }

  /* ---------- Waveform peaks ---------- */

  /* Per-column min/max peaks across all channels (merged), for drawing a
     waveform image. Returns {min: Float32Array, max: Float32Array}. */
  function computeWaveformPeaks(channelData, width) {
    var w = Math.max(1, Math.round(Number(width) || 0));
    var n = channelData && channelData.length ? channelData[0].length : 0;
    var min = new Float32Array(w), max = new Float32Array(w);
    if (!n) return { min: min, max: max };
    for (var x = 0; x < w; x++) {
      var s = Math.floor(x * n / w), e = Math.max(s + 1, Math.floor((x + 1) * n / w));
      var lo = Infinity, hi = -Infinity;
      for (var c = 0; c < channelData.length; c++) {
        var ch = channelData[c];
        for (var i = s; i < e && i < n; i++) { var v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      min[x] = (lo === Infinity ? 0 : lo);
      max[x] = (hi === -Infinity ? 0 : hi);
    }
    return { min: min, max: max };
  }

  var api = {
    dbToLinear: dbToLinear,
    findSilenceBounds: findSilenceBounds,
    sliceChannels: sliceChannels,
    mixToMono: mixToMono,
    convertChannels: convertChannels,
    onsetEnvelope: onsetEnvelope,
    detectTempo: detectTempo,
    computeWaveformPeaks: computeWaveformPeaks
  };
  global.LoonaAudioExpansion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
