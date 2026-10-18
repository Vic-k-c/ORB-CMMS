'use strict';
// Turns whatever image a Super Admin uploads into the set of square PNG icons
// the installed app and the browser tab need (512, 192, 180, 64).
//
// The pixel logic is plain functions on {width, height, data} bitmaps with no
// dependencies, so it can be unit-tested without the image library. Only
// normalizeIcon() touches Jimp, and it is handed the Jimp class by the caller.

const NEAR_WHITE = 235;

function px(bm, x, y) {
  const i = (y * bm.width + x) * 4;
  return [bm.data[i], bm.data[i + 1], bm.data[i + 2], bm.data[i + 3]];
}

// Finds the box around the real artwork, ignoring a flat-coloured (or fully
// transparent) margin. Uploaded icons very often arrive as a rounded square
// sitting on a big white canvas; without trimming, the installed icon would
// be a small tile floating in white.
function contentBounds(bm) {
  const { width: w, height: h, data } = bm;
  const [br, bg, bb, ba] = px(bm, 0, 0);
  const bgTransparent = ba < 16;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      let isContent;
      if (bgTransparent) isContent = a >= 16;
      else if (a < 16) isContent = false;
      else isContent = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 30;
      if (isContent) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h }; // blank image: leave alone
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function transparentShare(bm) {
  const { width: w, height: h, data } = bm;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) n++;
  return n / (w * h);
}

// A rounded-square icon pasted on white leaves white wedges in its four
// corners once the margin is trimmed. If all four corners are near-white AND
// the connected white area is only a small share of the image, it is those
// wedges - make them transparent so the icon looks like it was designed.
// A logo on a plain white background (large white area) is deliberately NOT
// touched: it would vanish against a dark launcher. Returns true if changed.
function clearRoundedCorners(bm) {
  const { width: w, height: h, data } = bm;
  const isLight = (p) => {
    const i = p * 4;
    return data[i + 3] > 0 && data[i] >= NEAR_WHITE && data[i + 1] >= NEAR_WHITE && data[i + 2] >= NEAR_WHITE;
  };
  const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + w - 1];
  if (!corners.every(isLight)) return false;

  const seen = new Uint8Array(w * h);
  const stack = [];
  const filled = [];
  for (const c of corners) if (!seen[c]) { seen[c] = 1; stack.push(c); }
  while (stack.length) {
    const p = stack.pop();
    filled.push(p);
    const x = p % w, y = (p - x) / w;
    if (x + 1 < w) { const q = p + 1; if (!seen[q] && isLight(q)) { seen[q] = 1; stack.push(q); } }
    if (x > 0)     { const q = p - 1; if (!seen[q] && isLight(q)) { seen[q] = 1; stack.push(q); } }
    if (y + 1 < h) { const q = p + w; if (!seen[q] && isLight(q)) { seen[q] = 1; stack.push(q); } }
    if (y > 0)     { const q = p - w; if (!seen[q] && isLight(q)) { seen[q] = 1; stack.push(q); } }
  }
  if (filled.length / (w * h) > 0.12) return false;

  for (const p of filled) data[p * 4 + 3] = 0;

  // Eat the light anti-aliasing fringe along the curved edge (two passes).
  let frontier = filled;
  for (let pass = 0; pass < 2; pass++) {
    const next = [];
    for (const p of frontier) {
      const x = p % w, y = (p - x) / w;
      const nbrs = [];
      if (x + 1 < w) nbrs.push(p + 1);
      if (x > 0) nbrs.push(p - 1);
      if (y + 1 < h) nbrs.push(p + w);
      if (y > 0) nbrs.push(p - w);
      for (const q of nbrs) {
        const i = q * 4;
        if (data[i + 3] === 0) continue;
        if (Math.min(data[i], data[i + 1], data[i + 2]) >= 175) { data[i + 3] = 0; next.push(q); }
      }
    }
    frontier = next;
  }
  return true;
}

// iPhones paint transparent pixels black on a home-screen icon, so the 180px
// version is flattened onto a solid colour: the icon's own background colour
// if it has transparent corners (sampled just inside the top edge), else white.
function opaqueFillColor(bm) {
  const { width: w, height: h } = bm;
  const corner = px(bm, 0, 0);
  if (corner[3] >= 16) return [255, 255, 255];
  const y = Math.max(2, Math.round(h * 0.06));
  const p = px(bm, Math.floor(w / 2), y);
  if (p[3] < 200) return [255, 255, 255];
  return [p[0], p[1], p[2]];
}

async function normalizeIcon(buffer, Jimp) {
  const src = await Jimp.read(buffer);

  const b = contentBounds(src.bitmap);
  if (b.w < src.bitmap.width || b.h < src.bitmap.height) src.crop(b.x, b.y, b.w, b.h);

  const w = src.bitmap.width, h = src.bitmap.height;
  const squareish = Math.min(w, h) / Math.max(w, h) >= 0.88;
  let master = null;
  let iconLike = false;

  if (squareish) {
    const candidate = src.clone().cover(512, 512);
    iconLike = clearRoundedCorners(candidate.bitmap);
    // A near-square mark on a transparent background is a logo, not an icon:
    // it needs a backdrop and some breathing room, handled below.
    if (iconLike || transparentShare(candidate.bitmap) <= 0.12) master = candidate;
    else iconLike = false;
  }
  if (!master) {
    // Wide/tall logo (or transparent mark): centre it on white with padding.
    const canvas = new Jimp(512, 512, 0xFFFFFFFF);
    const inner = src.clone().scaleToFit(Math.round(512 * 0.76), Math.round(512 * 0.76));
    canvas.composite(inner, Math.floor((512 - inner.bitmap.width) / 2), Math.floor((512 - inner.bitmap.height) / 2));
    master = canvas;
  }

  const png512 = await master.getBufferAsync(Jimp.MIME_PNG);
  const png192 = await master.clone().resize(192, 192).getBufferAsync(Jimp.MIME_PNG);
  const png64 = await master.clone().resize(64, 64).getBufferAsync(Jimp.MIME_PNG);

  const fill = opaqueFillColor(master.bitmap);
  const ios = master.clone().resize(180, 180);
  const flat = new Jimp(180, 180, Jimp.rgbaToInt(fill[0], fill[1], fill[2], 255));
  flat.composite(ios, 0, 0);
  const png180 = await flat.getBufferAsync(Jimp.MIME_PNG);

  return { png512, png192, png180, png64, iconLike };
}

module.exports = { contentBounds, clearRoundedCorners, transparentShare, opaqueFillColor, normalizeIcon };
