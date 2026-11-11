/* Loona Audio Tools - shared audio core.
   Pure functions only (no DOM access) so they can be unit-tested in Node.
   In the browser this attaches window.LoonaAudio; in Node it uses module.exports. */
(function (global) {
  'use strict';

  /* Convert a start/end selection in seconds into an exact sample range.
     Clamps to [0, duration], swaps if reversed, never returns a negative length. */
  function clampRange(startSec, endSec, durationSec, sampleRate) {
    var dur = Math.max(0, Number(durationSec) || 0);
    var s = Number(startSec), e = Number(endSec);
    if (!isFinite(s) || s < 0) s = 0;
    if (!isFinite(e) || e <= 0 || e > dur) e = dur;
    if (s > e) { var t = s; s = e; e = t; }
    if (s > dur) s = dur;
    var total = Math.round(dur * sampleRate);
    var startSample = Math.floor(s * sampleRate);
    var endSample = Math.ceil(e * sampleRate);
    if (endSample > total) endSample = total;
    if (startSample > endSample) startSample = endSample;
    if (startSample < 0) startSample = 0;
    return {
      start: startSample / sampleRate,
      end: endSample / sampleRate,
      startSample: startSample,
      endSample: endSample,
      length: endSample - startSample
    };
  }

  /* Return new per-channel arrays covering [startSample, endSample). */
  function sliceChannels(channelData, startSample, endSample) {
    return channelData.map(function (ch) { return ch.slice(startSample, endSample); });
  }

  /* Sum of a list of lengths. */
  function totalLength(lengths) {
    return lengths.reduce(function (a, b) { return a + b; }, 0);
  }

  /* Concatenate a list of per-channel array sets (all with the same channel
     count) into one per-channel set, preserving order. */
  function concatChannels(parts) {
    if (!parts.length) return [];
    var channels = parts[0].length;
    var total = 0;
    parts.forEach(function (p) { total += p[0].length; });
    var out = [];
    for (var c = 0; c < channels; c++) {
      var arr = new Float32Array(total);
      var off = 0;
      parts.forEach(function (p) { arr.set(p[c], off); off += p[c].length; });
      out.push(arr);
    }
    return out;
  }

  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /* Encode per-channel Float32 sample data as a 16-bit PCM WAV file.
     Returns a Uint8Array with a standard 44-byte RIFF header. */
  function encodeWAV(sampleRate, channelData) {
    var numCh = channelData.length;
    var len = channelData[0].length;
    var bytesPerSample = 2;
    var blockAlign = numCh * bytesPerSample;
    var dataSize = len * blockAlign;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          /* fmt chunk size */
    view.setUint16(20, 1, true);           /* PCM */
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);          /* bits per sample */
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    var offset = 44;
    for (var i = 0; i < len; i++) {
      for (var c = 0; c < numCh; c++) {
        var s = Math.max(-1, Math.min(1, channelData[c][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Uint8Array(buffer);
  }

  /* Seconds -> "m:ss.t" display string. */
  function formatTime(sec) {
    sec = Math.max(0, Number(sec) || 0);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var ss = s.toFixed(1);
    if (s < 10) ss = '0' + ss;
    return m + ':' + ss;
  }

  var api = {
    clampRange: clampRange,
    sliceChannels: sliceChannels,
    concatChannels: concatChannels,
    totalLength: totalLength,
    encodeWAV: encodeWAV,
    formatTime: formatTime
  };
  global.LoonaAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
