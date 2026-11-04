// Everything a download needs happens here, in the visitor's browser: fetch the parts, join video + audio, encode MP3 / H.264.
// mediabunny (MPL-2.0, js/vendor) does the container and codec work; big results go to the browser's private disk (OPFS) when it has one.
import {
  Input, Output, UrlSource, BlobSource, ALL_FORMATS, Mp4OutputFormat, Mp3OutputFormat, BufferTarget, StreamTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Conversion, canEncodeVideo, canEncodeAudio, QUALITY_HIGH,
} from './vendor/mediabunny.min.mjs';
import { registerMp3Encoder } from './vendor/mp3-encoder.min.mjs';

const MEM_LIMIT = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 7e8 : 1.6e9;   // without a private disk the whole file sits in memory

const opfsDir = async () => {
  try {
    if (!navigator.storage?.getDirectory || !('createWritable' in FileSystemFileHandle.prototype)) return null;
    return await (await navigator.storage.getDirectory()).getDirectoryHandle('downloader', { create: true });
  } catch { return null; }
};
/** Old results of earlier visits. */
export async function wipeDisk() {
  const d = await opfsDir(); if (!d) return;
  for await (const k of d.keys()) await d.removeEntry(k).catch(() => {});
}
let seq = 0;
async function sink(mime, est) {
  const d = await opfsDir();
  if (!d) {
    if (est > MEM_LIMIT) throw new Error('File terlalu besar untuk browser ini. Pilih kualitas lebih rendah.');
    const target = new BufferTarget();
    return { target, finish: () => new Blob([target.buffer], { type: mime }), drop: () => {} };
  }
  const name = Date.now() + '-' + (++seq), fh = await d.getFileHandle(name, { create: true }), w = await fh.createWritable();
  const target = new StreamTarget(new WritableStream({
    write: (c) => w.write({ type: 'write', position: c.position, data: c.data }),
    close: () => w.close(), abort: (e) => w.abort(e).catch(() => {}),
  }), { chunked: true, chunkSize: 2 ** 22 });
  return { target, finish: async () => { const f = await fh.getFile(); return new Blob([f], { type: mime }); }, drop: () => d.removeEntry(name).catch(() => {}) };
}
const src = (u) => new UrlSource(u, { parallelism: 3, maxCacheSize: 48 * 2 ** 20, getRetryDelay: (n) => (n < 6 ? 1000 * (n + 1) : null) });

function aborted(sig) { if (sig?.aborted) throw new DOMException('Dibatalkan', 'AbortError'); }

/** Joins a video-only and an audio-only stream into one MP4 without touching the picture. */
export async function join({ v, a, size = 0, tags, signal, onProgress }) {
  const vi = new Input({ source: src(v), formats: ALL_FORMATS });
  const ai = a ? new Input({ source: src(a), formats: ALL_FORMATS }) : null;
  const vt = await vi.getPrimaryVideoTrack(), at = ai && await ai.getPrimaryAudioTrack();
  if (!vt) throw new Error('Video tidak bisa dibaca.');
  const dur = await vt.computeDuration().catch(() => 0) || 0;
  const s = await sink('video/mp4', size);
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: s.target });
  const vs = new EncodedVideoPacketSource(vt.codec), as = at ? new EncodedAudioPacketSource(at.codec) : null;
  out.addVideoTrack(vs, { rotation: vt.rotation || 0 });
  if (as) out.addAudioTrack(as);
  if (tags) out.setMetadataTags(tags);
  try {
    await out.start();
    const copy = async (track, source, main) => {
      const meta = { decoderConfig: await track.getDecoderConfig() };
      let first = true;
      for await (const p of new EncodedPacketSink(track).packets()) {
        aborted(signal);
        await source.add(p, first ? meta : undefined);
        first = false;
        if (main && dur) onProgress?.(Math.min(1, p.timestamp / dur));
      }
      source.close();
    };
    await Promise.all([copy(vt, vs, true), at ? copy(at, as, false) : null]);
    await out.finalize();
    return await s.finish();
  } catch (e) {
    await out.cancel().catch(() => {}); s.drop();
    throw e;
  } finally { vi.dispose?.(); ai?.dispose?.(); }
}

async function convert({ input, make, mime, video, audio, tags, est, signal, onProgress }) {
  const s = await sink(mime, est);
  const output = new Output({ format: make(), target: s.target });
  const c = await Conversion.init({ input, output, video, audio, tags });
  if (!c.isValid) { s.drop(); throw new Error('Format ini tidak bisa diubah di browser ini.'); }
  c.onProgress = (p) => onProgress?.(p);
  const stop = () => c.cancel();
  signal?.addEventListener('abort', stop);
  try { await c.execute(); return await s.finish(); }
  catch (e) { s.drop(); throw e; }
  finally { signal?.removeEventListener('abort', stop); input.dispose?.(); }
}

let mp3Ready = false;
/** Any audio or video address → MP3 (the browser decodes, LAME in WebAssembly encodes). */
export async function toMp3({ url, abr, tags, est, signal, onProgress }) {
  if (typeof AudioDecoder === 'undefined') throw new Error('Browser ini belum bisa membuat MP3. Perbarui browser atau pilih MP4.');
  if (!mp3Ready && !(await canEncodeAudio('mp3'))) registerMp3Encoder();
  mp3Ready = true;
  return convert({
    input: new Input({ source: src(url), formats: ALL_FORMATS }), make: () => new Mp3OutputFormat(), mime: 'audio/mpeg',
    video: { discard: true }, audio: { codec: 'mp3', bitrate: abr * 1000, forceTranscode: true }, tags, est, signal, onProgress,
  });
}

/** Can this browser write H.264 at this size? */
export const canH264 = (width, height) => canEncodeVideo('avc', { width, height }).catch(() => false);

/** VP9 / AV1 file → H.264 MP4, on this device's own video encoder. */
export function toH264({ file, est, signal, onProgress }) {
  return convert({
    input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }), make: () => new Mp4OutputFormat({ fastStart: false }), mime: 'video/mp4',
    video: { codec: 'avc', forceTranscode: true, bitrate: QUALITY_HIGH, hardwareAcceleration: 'prefer-hardware' }, est, signal, onProgress,
  });
}

/** One whole file with progress. */
export async function grab(url, { signal, onProgress, type } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0, parts = [];
  let got = 0;
  const rd = r.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  return new Blob(parts, { type: type || r.headers.get('content-type') || 'application/octet-stream' });
}

// ---------- ZIP (stored, no compression: photos and videos are compressed already) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export async function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), buf = new Uint8Array(await f.blob.arrayBuffer());
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    c = (c ^ 0xffffffff) >>> 0;
    const head = (sig, extra) => {
      const h = new DataView(new ArrayBuffer(extra)); let p = 0;
      const w = (v) => { h.setUint16(p, v, true); p += 2; }, d = (v) => { h.setUint32(p, v, true); p += 4; };
      d(sig); if (sig === 0x02014b50) w(20);
      w(20); w(0x0800); w(0); w(0); w(0x21); d(c); d(buf.length); d(buf.length); w(name.length); w(0);
      if (sig === 0x02014b50) { w(0); w(0); w(0); d(0); d(off); }
      return new Uint8Array(h.buffer);
    };
    central.push(head(0x02014b50, 46), name);
    const lh = head(0x04034b50, 30);
    parts.push(lh, name, buf);
    off += lh.length + name.length + buf.length;
  }
  const cs = central.reduce((n, b) => n + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
