/* Loona Audio Tools - hand-rolled ID3v2 reader/writer for the MP3 Tag
   Editor. Parses ID3v2.3 and ID3v2.4 tags (title, artist, album, year,
   cover art), rewrites text frames and cover art WITHOUT touching the
   MP3 audio frames, preserves any other frames it does not edit, and
   can strip the tag entirely. Pure byte functions (no DOM) so they can
   be unit-tested in Node. Attaches window.LoonaID3 / module.exports. */
(function (global) {
  'use strict';

  var TEXT_FRAMES = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year' };

  function synchsafeToInt(b, off) {
    return ((b[off] & 0x7F) << 21) | ((b[off + 1] & 0x7F) << 14) | ((b[off + 2] & 0x7F) << 7) | (b[off + 3] & 0x7F);
  }
  function intToSynchsafe(n) {
    return [ (n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F ];
  }
  function u32be(b, off) { return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0; }

  function decodeText(data) {
    if (!data.length) return '';
    var enc = data[0], body = data.subarray(1), text = '';
    try {
      if (enc === 0) text = new TextDecoder('iso-8859-1').decode(body);
      else if (enc === 1) text = new TextDecoder('utf-16').decode(body);
      else if (enc === 2) text = new TextDecoder('utf-16be').decode(body);
      else text = new TextDecoder('utf-8').decode(body);
    } catch (e) {
      for (var i = 0; i < body.length; i++) text += String.fromCharCode(body[i]);
    }
    var nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    return text;
  }

  /* Encode a text frame payload: encoding 0 (Latin-1) when every
     character fits, otherwise encoding 1 (UTF-16LE with BOM). */
  function encodeTextData(text) {
    text = String(text == null ? '' : text);
    var latin = true, i;
    for (i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xFF) { latin = false; break; }
    if (latin) {
      var out0 = new Uint8Array(1 + text.length);
      out0[0] = 0;
      for (i = 0; i < text.length; i++) out0[1 + i] = text.charCodeAt(i) & 0xFF;
      return out0;
    }
    var out1 = new Uint8Array(3 + text.length * 2);
    out1[0] = 1; out1[1] = 0xFF; out1[2] = 0xFE;
    for (i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      out1[3 + i * 2] = code & 0xFF;
      out1[3 + i * 2 + 1] = (code >> 8) & 0xFF;
    }
    return out1;
  }

  function parseAPIC(data) {
    if (!data.length) return null;
    var enc = data[0], i = 1, mime = '';
    while (i < data.length && data[i] !== 0) { mime += String.fromCharCode(data[i]); i++; }
    i++; /* mime null */
    if (i >= data.length) return null;
    var pictureType = data[i]; i++;
    if (enc === 1 || enc === 2) {
      var start = i;
      while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0 && ((i - start) % 2 === 0))) i++;
      i += 2;
    } else {
      while (i < data.length && data[i] !== 0) i++;
      i++;
    }
    if (i > data.length) return null;
    return { mime: mime || 'image/jpeg', pictureType: pictureType, data: data.slice(i) };
  }

  function buildAPICData(cover) {
    var mime = cover.mime || 'image/jpeg';
    var head = [0]; /* encoding 0, empty description */
    var i;
    for (i = 0; i < mime.length; i++) head.push(mime.charCodeAt(i) & 0xFF);
    head.push(0, (cover.pictureType == null ? 3 : cover.pictureType), 0);
    var out = new Uint8Array(head.length + cover.data.length);
    out.set(head, 0); out.set(cover.data, head.length);
    return out;
  }

  /* Parse an MP3 byte array. Returns:
     {hasTag, version (3|4|2|0), unsupported, tagSize, totalTagBytes,
      audioStart, tags:{title,artist,album,year}, cover|null,
      rawFrames:[{id, bytes}]} - rawFrames holds every complete frame
     (header+data) for preservation. version 2 tags are reported but not
     parsed (rare; the editor writes a fresh v2.3 tag alongside). */
  function parseID3(bytes) {
    var res = { hasTag: false, version: 0, unsupported: false, tagSize: 0, totalTagBytes: 0, audioStart: 0, tags: {}, cover: null, rawFrames: [] };
    if (!bytes || bytes.length < 10) return res;
    if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return res; /* "ID3" */
    res.hasTag = true;
    res.version = bytes[3];
    var flags = bytes[5];
    res.tagSize = synchsafeToInt(bytes, 6);
    res.totalTagBytes = 10 + res.tagSize + ((res.version === 4 && (flags & 0x10)) ? 10 : 0);
    res.audioStart = res.totalTagBytes;
    if (res.version !== 3 && res.version !== 4) { res.unsupported = true; return res; }
    var off = 10, end = Math.min(bytes.length, 10 + res.tagSize);
    while (off + 10 <= end) {
      var id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      var size = (res.version === 4) ? synchsafeToInt(bytes, off + 4) : u32be(bytes, off + 4);
      if (size < 0 || off + 10 + size > end) break;
      var data = bytes.slice(off + 10, off + 10 + size);
      res.rawFrames.push({ id: id, bytes: bytes.slice(off, off + 10 + size) });
      if (TEXT_FRAMES[id] && res.tags[TEXT_FRAMES[id]] == null) {
        var val = decodeText(data);
        if (id === 'TYER' || id === 'TDRC') val = val.slice(0, 4);
        res.tags[TEXT_FRAMES[id]] = val;
      } else if (id === 'APIC' && !res.cover) {
        res.cover = parseAPIC(data);
      }
      off += 10 + size;
    }
    return res;
  }

  function buildFrame(id, data) {
    var out = new Uint8Array(10 + data.length);
    for (var i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    out[4] = (data.length >> 24) & 0xFF; out[5] = (data.length >> 16) & 0xFF;
    out[6] = (data.length >> 8) & 0xFF; out[7] = data.length & 0xFF;
    out[8] = 0; out[9] = 0;
    out.set(data, 10);
    return out;
  }

  function concat(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  /* Build a complete ID3v2.3 tag from edited fields, an optional cover
     and preserved raw frames (already filtered by the caller). */
  function buildTag(fields, cover, preservedFrames) {
    var frames = [];
    if (fields.title) frames.push(buildFrame('TIT2', encodeTextData(fields.title)));
    if (fields.artist) frames.push(buildFrame('TPE1', encodeTextData(fields.artist)));
    if (fields.album) frames.push(buildFrame('TALB', encodeTextData(fields.album)));
    if (fields.year) frames.push(buildFrame('TYER', encodeTextData(String(fields.year).slice(0, 4))));
    if (cover) frames.push(buildFrame('APIC', buildAPICData(cover)));
    (preservedFrames || []).forEach(function (f) { frames.push(f.bytes); });
    var body = concat(frames);
    var head = new Uint8Array(10);
    head[0] = 0x49; head[1] = 0x44; head[2] = 0x33; head[3] = 3; head[4] = 0; head[5] = 0;
    var ss = intToSynchsafe(body.length);
    head[6] = ss[0]; head[7] = ss[1]; head[8] = ss[2]; head[9] = ss[3];
    return concat([head, body]);
  }

  var EDITABLE_IDS = ['TIT2', 'TPE1', 'TALB', 'TYER', 'TDRC', 'APIC'];

  /* Rewrite an MP3's tags. `fields` may contain title/artist/album/year:
     a present key sets the value (empty string clears it); an absent key
     keeps the file's existing value. opts.coverAction:
     'keep' (default) | 'remove' | 'replace' (with opts.cover). Frames
     the editor does not manage (comments, genres, custom frames...)
     are preserved byte-for-byte, and the audio data is never re-encoded
     or modified - only the tag block at the front changes. */
  function rewriteTags(mp3Bytes, fields, opts) {
    fields = fields || {}; opts = opts || {};
    var parsed = parseID3(mp3Bytes);
    var audio = parsed.hasTag ? mp3Bytes.slice(parsed.totalTagBytes) : mp3Bytes.slice(0);
    var kept = {};
    ['title', 'artist', 'album', 'year'].forEach(function (k) {
      kept[k] = (k in fields) ? fields[k] : (parsed.tags[k] || '');
    });
    var preserved = parsed.rawFrames.filter(function (f) { return EDITABLE_IDS.indexOf(f.id) < 0; });
    var cover = parsed.cover;
    if (opts.coverAction === 'remove') cover = null;
    else if (opts.coverAction === 'replace') cover = opts.cover || null;
    if (!kept.title && !kept.artist && !kept.album && !kept.year && !cover && !preserved.length) {
      return audio; /* nothing left worth a tag */
    }
    return concat([buildTag(kept, cover, preserved), audio]);
  }

  /* Remove the ID3v2 tag (and a trailing ID3v1 tag if present). */
  function stripTags(mp3Bytes) {
    var parsed = parseID3(mp3Bytes);
    var out = parsed.hasTag ? mp3Bytes.slice(parsed.totalTagBytes) : mp3Bytes.slice(0);
    if (out.length > 128) {
      var t = out.length - 128;
      if (out[t] === 0x54 && out[t + 1] === 0x41 && out[t + 2] === 0x47) out = out.slice(0, t); /* "TAG" */
    }
    return out;
  }

  var api = {
    parseID3: parseID3,
    buildTag: buildTag,
    rewriteTags: rewriteTags,
    stripTags: stripTags,
    decodeText: decodeText,
    encodeTextData: encodeTextData,
    synchsafeToInt: synchsafeToInt,
    intToSynchsafe: intToSynchsafe,
    TEXT_FRAMES: TEXT_FRAMES
  };
  global.LoonaID3 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
