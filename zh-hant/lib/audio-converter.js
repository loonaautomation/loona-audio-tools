/* Loona Audio Tools - audio converter core (WAV + MP3 export).
   Pure functions only (no DOM access, apart from optional Blob helpers at
   the bottom) so they can be unit-tested in Node.
   WAV encoding is implemented here natively (16-bit PCM, same byte layout
   as lib/audio-core.js). MP3 encoding uses lamejs (lib/lame.min.js,
   lamejs 1.2.1, 156,043 bytes, LGPL) which must be loaded before use in
   the browser; in Node it can be passed in explicitly as the 4th argument
   to encodeMP3 or loaded onto the global object.
   In the browser this attaches window.LoonaAudioConverter; in Node it
   uses module.exports. */
(function (global) {
  'use strict';

  var SUPPORTED_BITRATES = [128, 192, 320];

  /* Nearest supported MP3 bitrate (kbps). Defaults to 192 for bad input. */
  function normalizeBitrate(kbps) {
    var v = Number(kbps);
    if (!isFinite(v) || v <= 0) return 192;
    var best = SUPPORTED_BITRATES[0], bestDiff = Infinity;
    for (var i = 0; i < SUPPORTED_BITRATES.length; i++) {
      var d = Math.abs(SUPPORTED_BITRATES[i] - v);
      if (d < bestDiff) { bestDiff = d; best = SUPPORTED_BITRATES[i]; }
    }
    return best;
  }

  /* File extension (lowercase, no dot) from a file name, or '' if none. */
  function extensionFromName(name) {
    var m = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(String(name || '').trim());
    return m ? m[1].toLowerCase() : '';
  }

  /* Human label for an input file: its extension when known, otherwise
     the subtype of its MIME type, otherwise 'Unknown'. */
  function formatLabel(name, mimeType) {
    var ext = extensionFromName(name);
    if (ext) return ext.toUpperCase();
    var mt = String(mimeType || '');
    var slash = mt.indexOf('/');
    if (slash >= 0 && mt.length > slash + 1) return mt.slice(slash + 1).toUpperCase();
    return '未知';
  }

  /* One Float32 channel -> Int16 PCM samples (clamped to [-1, 1]). */
  function floatChannelToInt16(channel) {
    var out = new Int16Array(channel.length);
    for (var i = 0; i < channel.length; i++) {
      var s = Math.max(-1, Math.min(1, channel[i] || 0));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
    }
    return out;
  }

  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /* Encode per-channel Float32 sample data as a 16-bit PCM WAV file.
     Returns a Uint8Array with a standard 44-byte RIFF header.
     Identical byte layout to LoonaAudio.encodeWAV in lib/audio-core.js. */
  function encodeWAV(sampleRate, channelData) {
    if (!channelData || !channelData.length) throw new Error('沒有音訊聲道可編碼。');
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
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            /* PCM */
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);           /* bits per sample */
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

  function resolveLame(override) {
    if (override && override.Mp3Encoder) return override;
    if (typeof global !== 'undefined' && global.lamejs && global.lamejs.Mp3Encoder) return global.lamejs;
    return null;
  }

  /* Encode per-channel Float32 sample data as MP3 with lamejs.
     bitrate is normalised to 128 / 192 / 320 kbps.
     Mono input (1 channel) is encoded as mono; stereo-or-more input uses
     the first two channels. Sample rate is passed through unchanged.
     Returns a Uint8Array (the MP3 byte stream, starting with a frame sync;
     lamejs does not write an ID3 tag here). Throws if lamejs is missing
     or the sample rate is not one lame supports (it accepts the standard
     MPEG rates such as 44100, 48000, 32000, 22050, 16000, 11025, 8000). */
  function encodeMP3(sampleRate, channelData, bitrateKbps, lameOverride) {
    var lame = resolveLame(lameOverride);
    if (!lame) throw new Error('MP3 編碼器 (lamejs) 未載入。');
    if (!channelData || !channelData.length) throw new Error('沒有音訊聲道可編碼。');
    var sr = Math.round(Number(sampleRate) || 0);
    if (!(sr > 0)) throw new Error('取樣率無效。');
    var kbps = normalizeBitrate(bitrateKbps);
    var numCh = channelData.length >= 2 ? 2 : 1;
    var left = floatChannelToInt16(channelData[0]);
    var right = numCh === 2 ? floatChannelToInt16(channelData[1]) : null;
    var encoder = new lame.Mp3Encoder(numCh, sr, kbps);
    var chunks = [];
    var total = 0;
    var BLOCK = 1152;
    for (var i = 0; i < left.length; i += BLOCK) {
      var lChunk = left.subarray(i, i + BLOCK);
      var data = (numCh === 2)
        ? encoder.encodeBuffer(lChunk, right.subarray(i, i + BLOCK))
        : encoder.encodeBuffer(lChunk);
      if (data && data.length > 0) { chunks.push(new Uint8Array(data)); total += data.length; }
    }
    var end = encoder.flush();
    if (end && end.length > 0) { chunks.push(new Uint8Array(end)); total += end.length; }
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], off); off += chunks[j].length; }
    return out;
  }

  /* Expected WAV byte size for frames of audio (44-byte header + PCM). */
  function estimateWavSize(sampleRate, channels, frames) {
    return 44 + Math.max(0, Math.round(frames) || 0) * Math.max(1, channels || 1) * 2;
  }

  /* Rough MP3 byte size for a duration at a bitrate (CBR estimate). */
  function estimateMp3Size(durationSec, bitrateKbps) {
    return Math.round(Math.max(0, Number(durationSec) || 0) * normalizeBitrate(bitrateKbps) * 1000 / 8);
  }

  var api = {
    SUPPORTED_BITRATES: SUPPORTED_BITRATES.slice(),
    normalizeBitrate: normalizeBitrate,
    extensionFromName: extensionFromName,
    formatLabel: formatLabel,
    floatChannelToInt16: floatChannelToInt16,
    encodeWAV: encodeWAV,
    encodeMP3: encodeMP3,
    estimateWavSize: estimateWavSize,
    estimateMp3Size: estimateMp3Size
  };

  /* ---- Browser helpers (not used in Node) ---- */
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    api.channelsToWavBlob = function (sampleRate, channelData) {
      return new Blob([encodeWAV(sampleRate, channelData)], { type: 'audio/wav' });
    };
    api.channelsToMp3Blob = function (sampleRate, channelData, bitrateKbps) {
      return new Blob([encodeMP3(sampleRate, channelData, bitrateKbps)], { type: 'audio/mpeg' });
    };
  }

  global.LoonaAudioConverter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
