'use strict';
// Per-organization PWA plumbing: the manifest each organization installs, and
// the <head> tags that point a page at it. No dependencies, so it is testable.

const ORG_CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;

function cleanOrgCode(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return ORG_CODE_RE.test(t) ? t.toUpperCase() : null;
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function iconUrl(code, size, version) {
  return `/api/public/org-app-icon/${encodeURIComponent(code)}/${size}` + (version ? `?v=${encodeURIComponent(version)}` : '');
}

// Home-screen labels get cut off around 12 characters, so a long company
// name falls back to the short org code.
function shortNameFor(org) {
  const n = (org.name || '').trim();
  return n && n.length <= 12 ? n : org.orgCode;
}

// org = { name, orgCode, iconVersion }. iconVersion changes whenever the icon
// is re-uploaded, which busts the browser's cache of the icon URLs.
function buildManifest(org) {
  const code = org.orgCode;
  const v = org.iconVersion || 'default';
  return {
    name: org.name || code,
    short_name: shortNameFor(org),
    description: `${org.name || code} - maintenance management`,
    // A different id per organization is what lets one device install more
    // than one organization's app side by side.
    id: `/?org=${code}`,
    start_url: `/?org=${code}`,
    scope: '/',
    display: 'standalone',
    background_color: '#0B2545',
    theme_color: '#0B2545',
    icons: [
      { src: iconUrl(code, 192, v), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl(code, 512, v), sizes: '512x512', type: 'image/png', purpose: 'any' }
    ]
  };
}

// Rewrites the four organization-specific tags in index.html. With no org the
// page is returned untouched (the default ORB CMMS tags stay in place).
function injectPwaTags(html, org) {
  if (!org) return html;
  const code = org.orgCode;
  const v = org.iconVersion || 'default';
  return html
    .replace(/<link rel="manifest" href="[^"]*">/, `<link rel="manifest" href="/api/public/manifest/${esc(encodeURIComponent(code))}">`)
    .replace(/<link rel="apple-touch-icon" href="[^"]*">/, `<link rel="apple-touch-icon" href="${esc(iconUrl(code, 180, v))}">`)
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*">/, `<meta name="apple-mobile-web-app-title" content="${esc(shortNameFor(org))}">`)
    .replace(/<link id="faviconLink" rel="icon" type="image\/png" href="[^"]*">/, `<link id="faviconLink" rel="icon" type="image/png" href="${esc(iconUrl(code, 64, v))}">`);
}

module.exports = { cleanOrgCode, parseCookie, buildManifest, injectPwaTags, shortNameFor, iconUrl };
