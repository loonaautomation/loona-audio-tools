/* Loona Audio Tools - extra DSP helpers for the editing tools
   (speed changer, volume booster, reverser, fade editor, tone generator).
   Pure functions first (no DOM access) so they can be unit-tested in Node.
   Browser helpers at the bottom use window.LoonaAudio (lib/audio-core.js).
   In the browser this attaches window.LoonaAudioExtra; in Node it uses module.exports. */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) v = lo;
    return Math.min(hi, Math.max(lo, v));
  }

  /* Linear gain -> decibels. gain 1 = 0 dB, 2 = +6.02 dB, 0.5 = -6.02 dB. */
  function gainToDb(gain) {
    gain = Number(gain);
    if (!(gain > 0)) return -Infinity;
    return 20 * Math.log(gain) / Math.LN10;
  }

  /* Volume percent (100 = unchanged) -> decibels. */
  function percentToDb(percent) {
    return gainToDb((Number(percent) || 0) / 100);
  }

  /* Highest absolute sample value across all channels (0 for empty input). */
  function peakOf(channelData) {
    var peak = 0;
    for (var c = 0; c < channelData.length; c++) {
      var ch = channelData[c];
      for (var i = 0; i < ch.length; i++) {
        var v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /* Return NEW per-channel arrays with every sample multiplied by gain.
     Samples are NOT clipped here - values may exceed [-1, 1]; the WAV
     encoder in audio-core.js clamps at export time. */
  function applyGainToChannels(channelData, gain) {
    gain = Number(gain) || 0;
    return channelData.map(function (ch) {
      var out = new Float32Array(ch.length);
      for (var i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
      return out;
    });
  }

  /* Return NEW per-channel arrays scaled so the loudest sample equals
     targetPeak (default 1.0). Silent input is returned as a plain copy. */
  function normalizeChannels(channelData, targetPeak) {
    var target = (typeof targetPeak === 'number' && targetPeak > 0) ? targetPeak : 1;
    var peak = peakOf(channelData);
    if (peak <= 0) {
      return channelData.map(function (ch) { return ch.slice(); });
    }
    return applyGainToChannels(channelData, target / peak);
  }

  /* Return NEW per-channel arrays with each channel reversed in time.
     (Each channel reverses its own samples; channels are not swapped.) */
  function reverseChannels(channelData) {
    return channelData.map(function (ch) {
      var n = ch.length;
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) out[i] = ch[n - 1 - i];
      return out;
    });
  }

  /* Linear fade multiplier at time t (seconds) for a clip of duration
     seconds, with a fade-in of fadeIn seconds and a fade-out of fadeOut
     seconds. Result is always in [0, 1]. A fade of 0 disables that side. */
  function fadeMultiplier(t, duration, fadeIn, fadeOut) {
    var m = 1;
    if (fadeIn > 0 && t < fadeIn) m = Math.min(m, t / fadeIn);
    if (fadeOut > 0 && t > duration - fadeOut) m = Math.min(m, Math.max(0, (duration - t) / fadeOut));
    if (t <= 0) m = (fadeIn > 0) ? 0 : Math.min(m, 1);
    if (t >= duration) m = (fadeOut > 0) ? 0 : Math.min(m, 1);
    return clamp(m, 0, 1);
  }

  /* Return NEW per-channel arrays with linear fade-in / fade-out applied. */
  function applyFades(channelData, sampleRate, fadeInSec, fadeOutSec) {
    if (!channelData.length) return [];
    var len = channelData[0].length;
    var duration = len / sampleRate;
    return channelData.map(function (ch) {
      var out = new Float32Array(len);
      for (var i = 0; i < len; i++) {
        out[i] = ch[i] * fadeMultiplier(i / sampleRate, duration, fadeInSec, fadeOutSec);
      }
      return out;
    });
  }

  /* Changing playback speed by rate (2 = twice as fast) divides the
     duration by rate. Pitch rises/falls with the speed - no correction. */
  function speedOutputDuration(durationSec, rate) {
    rate = Number(rate);
    if (!(rate > 0)) rate = 1;
    return (Number(durationSec) || 0) / rate;
  }

  function speedOutputFrames(frames, rate) {
    rate = Number(rate);
    if (!(rate > 0)) rate = 1;
    return Math.max(1, Math.round((Number(frames) || 0) / rate));
  }

  /* One sample of a test tone. phase = freq * t (cycles). */
  function toneValue(waveform, freq, t) {
    var phase = (Number(freq) || 0) * (Number(t) || 0);
    var frac = phase - Math.floor(phase);
    switch (waveform) {
      case 'square':
        return frac < 0.5 ? 1 : -1;
      case 'triangle':
        return frac < 0.5 ? (4 * frac - 1) : (3 - 4 * frac);
      case 'sawtooth':
        return 2 * frac - 1;
      case 'sine':
      default:
        return Math.sin(2 * Math.PI * phase);
    }
  }

  /* Number of sample frames for a tone of durationSec at sampleRate. */
  function toneFrameCount(durationSec, sampleRate) {
    return Math.max(1, Math.round((Number(durationSec) || 0) * sampleRate));
  }

  /* Render one channel of a pure tone (used for previews/tests; the tone
     page renders the same shape through an OfflineAudioContext oscillator). */
  function renderToneChannel(waveform, freq, durationSec, sampleRate, amplitude) {
    var amp = (typeof amplitude === 'number') ? amplitude : 0.5;
    var n = toneFrameCount(durationSec, sampleRate);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = amp * toneValue(waveform, freq, i / sampleRate);
    return out;
  }

  var api = {
    clamp: clamp,
    gainToDb: gainToDb,
    percentToDb: percentToDb,
    peakOf: peakOf,
    applyGainToChannels: applyGainToChannels,
    normalizeChannels: normalizeChannels,
    reverseChannels: reverseChannels,
    fadeMultiplier: fadeMultiplier,
    applyFades: applyFades,
    speedOutputDuration: speedOutputDuration,
    speedOutputFrames: speedOutputFrames,
    toneValue: toneValue,
    toneFrameCount: toneFrameCount,
    renderToneChannel: renderToneChannel
  };

  /* ---- Browser helpers (not used in Node) ---- */
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    /* Encode an AudioBuffer (or OfflineAudioContext result) as a WAV Blob
       using the shared encoder from lib/audio-core.js. */
    api.bufferToWavBlob = function (audioBuffer) {
      var channels = [];
      for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
      }
      var bytes = window.LoonaAudio.encodeWAV(audioBuffer.sampleRate, channels);
      return new Blob([bytes], { type: 'audio/wav' });
    };
    /* Encode raw per-channel arrays as a WAV Blob. */
    api.channelsToWavBlob = function (sampleRate, channelData) {
      var bytes = window.LoonaAudio.encodeWAV(sampleRate, channelData);
      return new Blob([bytes], { type: 'audio/wav' });
    };
    api.downloadBlob = function (blob, filename) {
      var u = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = u;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
    };
    /* Create an OfflineAudioContext matching a source buffer, with an
       optional different output length in frames (used by speed change). */
    api.makeOffline = function (buffer, outFrames) {
      var frames = outFrames || buffer.length;
      var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      return new OC(buffer.numberOfChannels, frames, buffer.sampleRate);
    };
  }

  global.LoonaAudioExtra = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
