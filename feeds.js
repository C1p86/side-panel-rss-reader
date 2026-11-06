import { t } from './i18n.js';

const FETCH_TIMEOUT_MS = 20000;
const MAX_ITEMS_PER_FEED = 100;
const FEEDER_FINDER_URL = 'https://feeder.co/mcp/public';

/** Fetches a URL and decodes it with its declared charset (res.text() would force UTF-8). */
export async function fetchDecoded(url) {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return { text: decode(buffer, res.headers.get('content-type')), url: res.url };
}

function decode(buffer, contentType) {
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 2048));
  const candidates = [
    /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1],
    /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1],
    /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1],
  ];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(buffer);
    } catch {
      // Unknown charset label: try the next candidate.
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/** Resolves a URL and accepts only http(s), so feeds cannot inject javascript: links. */
export function safeUrl(raw, base) {
  const value = (raw || '').trim();
  if (!value) return ''; // new URL('', base) would silently return the base itself.
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function child(el, ...names) {
  for (const name of names) {
    const found = [...el.children].find((c) => c.nodeName === name);
    if (found) return found;
  }
  return null;
}

function text(el, ...names) {
  return child(el, ...names)?.textContent.trim() || '';
}

// Feed titles are often double-escaped ("Tom &amp;amp; Jerry") or contain markup.
function plainText(value) {
  if (!/[<&]/.test(value)) return value;
  return new DOMParser().parseFromString(value, 'text/html').body.textContent.trim();
}

function atomLink(el, base) {
  const links = [...el.children].filter((c) => c.nodeName === 'link');
  const alternate = links.filter((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
  const link = alternate.find((l) => (l.getAttribute('type') || '').includes('html')) || alternate[0];
  return safeUrl(link?.getAttribute('href'), base);
}

function atomContent(el) {
  const node = child(el, 'content', 'summary');
  if (!node) return '';
  return node.getAttribute('type') === 'xhtml' ? node.innerHTML : node.textContent;
}

function parseDate(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Picks a preview image: explicit feed media first, then the first real image in the item's HTML. */
function itemImage(item, html, base) {
  const first = (name) => item.getElementsByTagName(name)[0];
  const isImage = (node) => {
    const type = node.getAttribute('type') || '';
    const medium = node.getAttribute('medium') || '';
    return medium === 'image' || type.startsWith('image/')
      || (!type && !medium && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(node.getAttribute('url') || ''));
  };
  const media = [...item.getElementsByTagName('media:content'), ...item.getElementsByTagName('enclosure')].find(isImage);
  const explicit = first('media:thumbnail')?.getAttribute('url')
    || media?.getAttribute('url')
    || first('itunes:image')?.getAttribute('href');
  if (explicit) return safeUrl(explicit, base);

  if (!/<img/i.test(html)) return '';
  const images = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img[src]');
  const real = [...images].find((img) => !(Number(img.getAttribute('width')) <= 2 && img.hasAttribute('width')));
  return safeUrl(real?.getAttribute('src'), base);
}

function parseAtomEntry(entry, base) {
  const html = atomContent(entry);
  return {
    guid: text(entry, 'id'),
    title: plainText(text(entry, 'title')),
    link: atomLink(entry, base),
    date: parseDate(text(entry, 'published', 'updated')),
    author: text(child(entry, 'author') || entry, 'name', 'dc:creator'),
    html,
    image: itemImage(entry, html, base),
  };
}

function parseRssItem(item, base) {
  const guid = text(item, 'guid');
  const html = text(item, 'content:encoded', 'description');
  return {
    guid,
    title: plainText(text(item, 'title')),
    link: safeUrl(text(item, 'link'), base) || safeUrl(/^https?:/i.test(guid) ? guid : '', base),
    date: parseDate(text(item, 'pubDate', 'dc:date')),
    author: text(item, 'dc:creator', 'author'),
    html,
    image: itemImage(item, html, base),
  };
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. Throws when the document is not a feed. */
export function parseFeed(xml, feedUrl) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!['rss', 'RDF', 'feed'].includes(root?.localName)) {
    throw new Error(t('errNotFeed'));
  }
  const isAtom = root.localName === 'feed';
  const channel = isAtom ? root : child(root, 'channel');
  const siteUrl = (isAtom ? atomLink(root, feedUrl) : safeUrl(text(channel || root, 'link'), feedUrl)) || feedUrl;
  // After an XML error (e.g. a stray "&") the parser keeps what it read so far, so use that.
  const items = isAtom
    ? [...doc.getElementsByTagName('entry')].map((e) => parseAtomEntry(e, feedUrl))
    : [...doc.getElementsByTagName('item')].map((i) => parseRssItem(i, feedUrl));
  return {
    title: plainText(text(channel || root, 'title')) || new URL(siteUrl).hostname,
    siteUrl,
    items: items.filter((i) => i.link || i.guid),
  };
}

/** Looks for <link rel="alternate"> so the user can also paste a site's home page. */
export function findFeedLink(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const link = doc.querySelector(
    'link[rel~="alternate"][type="application/rss+xml"], link[rel~="alternate"][type="application/atom+xml"]',
  );
  return safeUrl(link?.getAttribute('href'), baseUrl);
}

function sameSite(hostA, hostB) {
  const [a, b] = [hostA, hostB].map((host) => host.replace(/^www\./, ''));
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Intranet names and IP addresses must not reach a third party (IPv6 hostnames contain ':'). */
export function canUseFeeder(siteUrl) {
  const { hostname } = new URL(siteUrl);
  return hostname.includes('.') && !hostname.includes(':') && !/^[\d.]+$/.test(hostname);
}

/**
 * Asks Feeder's public finder for a site's main feed. Returns '' when it has no usable answer.
 * Only the feed's own host is trusted: Feeder's site_url is declared by the feed, and feeds of
 * unrelated sites do claim to belong to others.
 */
export async function findFeedViaFeeder(siteUrl) {
  if (!canUseFeeder(siteUrl)) return '';
  const { hostname, origin, pathname } = new URL(siteUrl);

  const res = await fetch(FEEDER_FINDER_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'find_feed', arguments: { url: origin + pathname } }, // No query: it may hold tokens.
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return '';
  const feeds = (await res.json()).result?.structuredContent?.feeds || [];
  const match = feeds.find((feed) => {
    const url = feed.works && safeUrl(feed.feed_url);
    return url && sameSite(new URL(url).hostname, hostname);
  });
  return match ? safeUrl(match.feed_url) : '';
}

/** Finds a site's icon from its home page HTML, falling back to the conventional /favicon.ico. */
export function findSiteIcon(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const link = doc.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]');
  return safeUrl(link?.getAttribute('href'), baseUrl) || new URL('/favicon.ico', baseUrl).href;
}

/** True when the item holds user data that must never be discarded automatically. */
export function isAnnotated(item) {
  return Boolean(item.favorite || item.tags?.length || item.note?.trim());
}

/** Merges fresh items with stored ones, keeping user data (read, favorite, tags, note) and first-seen dates. */
export function mergeItems(feedId, parsedItems, existing) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const now = Date.now();
  for (const parsed of parsedItems) {
    const id = `${feedId}|${parsed.guid || parsed.link}`;
    const old = byId.get(id);
    byId.set(id, {
      ...old,
      ...parsed,
      id,
      feedId,
      date: parsed.date || old?.date || now,
      image: parsed.image || old?.image || '', // Keep an image found on the page when the feed has none.
      read: old?.read || false,
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.date - a.date)
    .filter((item, index) => index < MAX_ITEMS_PER_FEED || isAnnotated(item));
}
