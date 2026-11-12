/* Loona Audio Tools - shared media helper core (screen recorder, mic test,
   webcam test). Pure functions only (no DOM access) so they can be
   unit-tested in Node. In the browser this attaches window.LoonaMedia;
   in Node it uses module.exports. */
(function (global) {
  'use strict';

  /* Root-mean-square level of a block of time-domain samples.
     Returns a number in [0, 1]; silence is 0, a full-scale signal is 1.
     Accepts any array-like of numbers (Float32Array from an AnalyserNode,
     or a plain array). Empty or invalid input returns 0. */
  function rmsLevel(samples) {
    if (!samples || !samples.length) return 0;
    var sum = 0, n = 0;
    for (var i = 0; i < samples.length; i++) {
      var v = Number(samples[i]);
      if (!isFinite(v)) continue;
      sum += v * v;
      n++;
    }
    if (!n) return 0;
    var rms = Math.sqrt(sum / n);
    if (rms < 0) rms = 0;
    if (rms > 1) rms = 1;
    return rms;
  }

  /* Peak absolute level of a block of samples, in [0, 1]. */
  function peakLevel(samples) {
    if (!samples || !samples.length) return 0;
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
      var v = Math.abs(Number(samples[i]) || 0);
      if (v > peak) peak = v;
    }
    if (peak > 1) peak = 1;
    return peak;
  }

  /* Convert an RMS level (0..1) to a meter percentage (0..100).
     Uses a decibel scale: -50 dBFS and below reads 0%, 0 dBFS reads 100%,
     so normal speech (around -20 dBFS) lands near 60% of the bar. */
  function meterPercent(rms) {
    rms = Number(rms) || 0;
    if (rms <= 0) return 0;
    if (rms >= 1) return 100;
    var db = 20 * Math.log10(rms);
    var p = ((db + 50) / 50) * 100;
    p = Math.round(p);
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    return p;
  }

  /* Level in decibels relative to full scale (dBFS), rounded to 1 decimal.
     Silence returns -Infinity (callers display it as "-inf" or "-"). */
  function levelDb(rms) {
    rms = Number(rms) || 0;
    if (rms <= 0) return -Infinity;
    return Math.round(20 * Math.log10(rms) * 10) / 10;
  }

  /* Elapsed seconds -> clock string: "0:05", "1:05", "59:59",
     and "1:00:00" once an hour is reached. Negative/NaN input reads 0. */
  function formatClock(sec) {
    sec = Math.floor(Math.max(0, Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec - h * 3600) / 60);
    var s = sec - h * 3600 - m * 60;
    var ss = (s < 10 ? '0' : '') + s;
    if (h > 0) {
      var mm = (m < 10 ? '0' : '') + m;
      return h + ':' + mm + ':' + ss;
    }
    return m + ':' + ss;
  }

  /* Candidate MediaRecorder MIME types, best first.
     Video: VP9 WebM, VP8 WebM, plain WebM, then MP4 (Safari 14.1+).
     Audio: Opus WebM, plain WebM, Opus OGG, then MP4 (Safari). */
  var MIME_CANDIDATES = {
    video: [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ],
    audio: [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ]
  };

  /* Pick the first MIME type the browser says it can record with.
     isSupported is a function like MediaRecorder.isTypeSupported, passed in
     so this stays pure and testable. Returns '' when nothing is supported
     (callers then let MediaRecorder use its own default). */
  function pickMimeType(kind, isSupported) {
    var list = MIME_CANDIDATES[kind] || [];
    if (typeof isSupported !== 'function') return list.length ? '' : '';
    for (var i = 0; i < list.length; i++) {
      var ok = false;
      try { ok = !!isSupported(list[i]); } catch (e) { ok = false; }
      if (ok) return list[i];
    }
    return '';
  }

  /* File extension for a recorded blob, from its MIME type. */
  function extensionFromMime(mime) {
    mime = String(mime || '').toLowerCase();
    if (mime.indexOf('mp4') >= 0) return 'mp4';
    if (mime.indexOf('ogg') >= 0) return 'ogg';
    if (mime.indexOf('mpeg') >= 0) return 'mp3';
    return 'webm';
  }

  var api = {
    rmsLevel: rmsLevel,
    peakLevel: peakLevel,
    meterPercent: meterPercent,
    levelDb: levelDb,
    formatClock: formatClock,
    pickMimeType: pickMimeType,
    extensionFromMime: extensionFromMime,
    MIME_CANDIDATES: MIME_CANDIDATES
  };
  global.LoonaMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
