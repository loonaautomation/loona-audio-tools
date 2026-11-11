/* Loona Audio Tools - research-additions helpers (metronome, tuner pitch
   detection, drum sequencer, ear training, noise generation).
   Pure functions only (no DOM access) so they can be unit-tested in Node.
   Browser playback/scheduling code lives on the tool pages and calls
   these functions for every decision it can.
   In the browser this attaches window.LoonaAudioResearch; in Node it
   uses module.exports. */
(function (global) {
  'use strict';

  /* ---------- Shared music maths ---------- */

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToFreq(midi) { return 440 * Math.pow(2, ((Number(midi) || 0) - 69) / 12); }
  function freqToMidi(freq) { return 69 + 12 * Math.log((Number(freq) || 0) / 440) / Math.LN2; }

  /* Frequency -> nearest note: {name, octave, midi, cents, noteFreq}.
     cents is signed deviation from the nearest note (-50..+50). */
  function freqToNote(freq) {
    freq = Number(freq) || 0;
    if (!(freq > 0)) return null;
    var midiFloat = freqToMidi(freq);
    var midi = Math.round(midiFloat);
    var noteFreq = midiToFreq(midi);
    return {
      name: NOTE_NAMES[((midi % 12) + 12) % 12],
      octave: Math.floor(midi / 12) - 1,
      midi: midi,
      cents: Math.round(1200 * Math.log(freq / noteFreq) / Math.LN2),
      noteFreq: noteFreq
    };
  }

  /* ---------- Tuner: autocorrelation pitch detection ---------- */

  /* Autocorrelation pitch estimate for a mono Float32 buffer.
     Returns {freq, clarity} - freq is -1 when the buffer is too quiet or
     no period is found. clarity is the normalised autocorrelation peak
     (tones score 0.9+, white noise ~0.03); callers should treat a result
     as a real pitch only when clarity is high (the tuner page uses 0.9). */
  function autoCorrelate(buf, sampleRate) {
    var SIZE = buf.length, i;
    var rms = 0;
    for (i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return { freq: -1, clarity: 0 };
    var r1 = 0, r2 = SIZE - 1, th = 0.2;
    for (i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) < th) { r1 = i; break; } }
    for (i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) < th) { r2 = SIZE - i; break; } }
    var b = buf.slice(r1, r2), N = b.length;
    if (N < 32) return { freq: -1, clarity: 0 };
    var c = new Float32Array(N), lag, j;
    for (lag = 0; lag < N; lag++) {
      var s = 0;
      for (j = 0; j < N - lag; j++) s += b[j] * b[j + lag];
      c[lag] = s;
    }
    var d = 0;
    while (d < N - 1 && c[d] > c[d + 1]) d++;
    var maxv = -1, maxp = -1;
    for (i = d; i < N; i++) { if (c[i] > maxv) { maxv = c[i]; maxp = i; } }
    if (maxp <= 0 || !(c[0] > 0)) return { freq: -1, clarity: 0 };
    var T0 = maxp;
    var x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
    var a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
    if (a) T0 = T0 - bb / (2 * a);
    return { freq: sampleRate / T0, clarity: maxv / c[0] };
  }

  /* ---------- Metronome ---------- */

  function clampBpm(bpm) {
    var v = Number(bpm) || 0;
    return Math.min(240, Math.max(30, v));
  }
  function beatIntervalSec(bpm) { return 60 / clampBpm(bpm); }

  /* Build the first `count` subdivision events of a metronome pattern.
     Times are offsets in seconds from 0 (the page adds the audio clock).
     An event is a beat start when subIndex === 0; beat 0 of each bar is
     accented. Returns [{time, beatInBar, subIndex, isBeat, isAccent}]. */
  function metronomeSchedule(opts) {
    var bpm = clampBpm(opts && opts.bpm);
    var beatsPerBar = Math.max(1, Math.min(12, Math.round((opts && opts.beatsPerBar) || 4)));
    var subdivision = Math.max(1, Math.min(4, Math.round((opts && opts.subdivision) || 1)));
    var count = Math.max(1, Math.round((opts && opts.count) || 16));
    var beatSec = 60 / bpm, subSec = beatSec / subdivision;
    var events = [], totalBeats = Math.ceil(count / subdivision);
    for (var beat = 0; beat < totalBeats; beat++) {
      for (var sub = 0; sub < subdivision; sub++) {
        var idx = beat * subdivision + sub;
        if (idx >= count) break;
        var inBar = beat % beatsPerBar;
        events.push({
          time: idx * subSec,
          beatInBar: inBar,
          subIndex: sub,
          isBeat: sub === 0,
          isAccent: sub === 0 && inBar === 0
        });
      }
    }
    return events;
  }

  /* ---------- Drum sequencer ---------- */

  var SEQ_STEPS = 16;              /* one bar of 16th notes */
  var SEQ_TRACKS = ['kick', 'snare', 'hihat', 'openhat'];

  function stepDurationSec(bpm) { return (60 / clampBpm(bpm)) / 4; }

  /* Expand a pattern {track: [16 x 0/1]} into timed events for `bars`
     bars starting at time 0. Returns [{time, step, bar, track}] sorted
     by time. Throws on a pattern row that is not 16 steps. */
  function sequencerEvents(pattern, bpm, bars) {
    var stepSec = stepDurationSec(bpm);
    var nBars = Math.max(1, Math.round(bars || 1));
    var events = [];
    SEQ_TRACKS.forEach(function (track) {
      var row = pattern && pattern[track];
      if (!row) return;
      if (row.length !== SEQ_STEPS) throw new Error('模式行“' + track + '”必須正好有 16 步。');
      for (var bar = 0; bar < nBars; bar++) {
        for (var step = 0; step < SEQ_STEPS; step++) {
          if (row[step]) events.push({ time: (bar * SEQ_STEPS + step) * stepSec, step: step, bar: bar, track: track });
        }
      }
    });
    events.sort(function (x, y) { return x.time - y.time; });
    return events;
  }

  /* Preset patterns (1 = hit). Written as strings for readability. */
  function row(str) { return str.split('').map(function (ch) { return ch === 'x' ? 1 : 0; }); }
  var SEQ_PRESETS = {
    'rock': { kick: row('x.......x.......'), snare: row('....x.......x...'), hihat: row('x.x.x.x.x.x.x.x.'), openhat: row('..............x.') },
    'house': { kick: row('x...x...x...x...'), snare: row('....x.......x...'), hihat: row('..x...x...x...x.'), openhat: row('..x.......x.....') },
    'hiphop': { kick: row('x.....x...x.....'), snare: row('....x.......x...'), hihat: row('x.x.x.x.x.x.x.xx'), openhat: row('................') },
    'basic': { kick: row('x.......x.......'), snare: row('....x.......x...'), hihat: row('x...x...x...x...'), openhat: row('................') }
  };

  /* ---------- Ear training (intervals) ---------- */

  var INTERVALS = [
    { semitones: 0, name: '純一度', short: 'P1' },
    { semitones: 1, name: '小二度', short: 'm2' },
    { semitones: 2, name: '大二度', short: 'M2' },
    { semitones: 3, name: '小三度', short: 'm3' },
    { semitones: 4, name: '大三度', short: 'M3' },
    { semitones: 5, name: '純四度', short: 'P4' },
    { semitones: 6, name: '三全音', short: 'TT' },
    { semitones: 7, name: '純五度', short: 'P5' },
    { semitones: 8, name: '小六度', short: 'm6' },
    { semitones: 9, name: '大六度', short: 'M6' },
    { semitones: 10, name: '小七度', short: 'm7' },
    { semitones: 11, name: '大七度', short: 'M7' },
    { semitones: 12, name: '純八度', short: 'P8' }
  ];

  function intervalBySemitones(semitones) {
    for (var i = 0; i < INTERVALS.length; i++) if (INTERVALS[i].semitones === semitones) return INTERVALS[i];
    return null;
  }

  /* A random ascending-interval question. rng is a function returning
     [0,1) (injectable for tests). Root is kept in MIDI 57-65 (A3-F4) so
     root+interval always stays in a comfortable singing range. */
  function makeIntervalQuestion(rng, maxSemitones) {
    var rand = typeof rng === 'function' ? rng : Math.random;
    var max = Math.max(1, Math.min(12, Math.round(maxSemitones || 12)));
    var semitones = 1 + Math.floor(rand() * max); /* 1..max, no unison questions */
    var rootMidi = 57 + Math.floor(rand() * 9);   /* 57..65 */
    var iv = intervalBySemitones(semitones);
    return {
      rootMidi: rootMidi,
      targetMidi: rootMidi + semitones,
      semitones: semitones,
      intervalName: iv.name,
      rootFreq: midiToFreq(rootMidi),
      targetFreq: midiToFreq(rootMidi + semitones)
    };
  }

  /* ---------- Noise generation ---------- */

  /* Deterministic PRNG (mulberry32) so tests - and a page that wants a
     repeatable buffer - can seed the noise. Pages pass Math.random-based
     seeds in normal use. */
  function mulberry32(seed) {
    var a = (Number(seed) || 0) | 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* White noise: equal energy at all frequencies. Scaled to 0.9 peak. */
  function generateWhite(length, rng) {
    var rand = typeof rng === 'function' ? rng : Math.random;
    var out = new Float32Array(length);
    for (var i = 0; i < length; i++) out[i] = (rand() * 2 - 1) * 0.9;
    return out;
  }

  /* Pink noise (Paul Kellet filter bank): energy falls 3 dB/octave, so
     every octave carries equal energy - the classic focus/sleep sound. */
  function generatePink(length, rng) {
    var rand = typeof rng === 'function' ? rng : Math.random;
    var out = new Float32Array(length);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < length; i++) {
      var w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return out;
  }

  /* Brown noise (leaky integration of white): energy falls 6 dB/octave -
     a deep rumble like heavy rain or a distant waterfall. */
  function generateBrown(length, rng) {
    var rand = typeof rng === 'function' ? rng : Math.random;
    var out = new Float32Array(length);
    var last = 0;
    for (var i = 0; i < length; i++) {
      var w = rand() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      var v = last * 3.5;
      out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
    }
    return out;
  }

  var api = {
    NOTE_NAMES: NOTE_NAMES.slice(),
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi,
    freqToNote: freqToNote,
    autoCorrelate: autoCorrelate,
    clampBpm: clampBpm,
    beatIntervalSec: beatIntervalSec,
    metronomeSchedule: metronomeSchedule,
    SEQ_STEPS: SEQ_STEPS,
    SEQ_TRACKS: SEQ_TRACKS.slice(),
    SEQ_PRESETS: SEQ_PRESETS,
    stepDurationSec: stepDurationSec,
    sequencerEvents: sequencerEvents,
    INTERVALS: INTERVALS.slice(),
    intervalBySemitones: intervalBySemitones,
    makeIntervalQuestion: makeIntervalQuestion,
    mulberry32: mulberry32,
    generateWhite: generateWhite,
    generatePink: generatePink,
    generateBrown: generateBrown
  };
  global.LoonaAudioResearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
