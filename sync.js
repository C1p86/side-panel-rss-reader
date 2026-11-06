import { t } from './i18n.js';

// Device-independent sync: everything here is keyed by feed URL and article guid/link,
// because feed ids (and so item ids) are random on each device.
const DOC_VERSION = 1;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000; // Read marks and deletions older than this are forgotten.
const MAX_ATTEMPTS = 3;

export class ConflictError extends Error {}

export function itemKey(item) {
  return item.id.slice(item.id.indexOf('|') + 1);
}

function hasAnnotation(entry) {
  return Boolean(entry.favorite || entry.tags?.length || entry.note?.trim());
}

/** Removes a feed but keeps the articles holding user data, remembering where they came from. */
export function removeFeed(state, feed, now = Date.now()) {
  return {
    feeds: state.feeds.filter((f) => f.id !== feed.id),
    removedFeeds: { ...state.removedFeeds, [feed.url]: now },
    items: state.items
      .filter((i) => i.feedId !== feed.id || hasAnnotation(i))
      .map((i) => (i.feedId === feed.id
        ? { ...i, feedTitle: feed.title, feedIcon: feed.icon, feedUrl: feed.url }
        : i)),
  };
}

/** Describes local data as a sync document. Article texts stay out: every device re-downloads them. */
export function buildLocalDoc(state, now = Date.now()) {
  const feeds = {};
  for (const [url, at] of Object.entries(state.removedFeeds || {})) feeds[url] = { removed: true, at };
  for (const feed of state.feeds) {
    const at = feed.addedAt || 0;
    if (feeds[feed.url]?.at > at) continue;
    feeds[feed.url] = { title: feed.title, siteUrl: feed.siteUrl || '', icon: feed.icon || '', at };
  }

  const feedById = new Map(state.feeds.map((f) => [f.id, f]));
  const read = {};
  const annotations = {};
  for (const item of state.items) {
    const key = itemKey(item);
    if (item.read) read[key] = now;
    if (!item.annotatedAt && !hasAnnotation(item)) continue;
    const feed = feedById.get(item.feedId);
    annotations[key] = {
      feedUrl: feed?.url || item.feedUrl || '',
      feedTitle: feed?.title || item.feedTitle || '',
      title: item.title || '',
      link: item.link || '',
      date: item.date || 0,
      author: item.author || '',
      image: item.image || '',
      favorite: Boolean(item.favorite),
      tags: item.tags || [],
      note: item.note || '',
      at: item.annotatedAt || 0,
    };
  }
  return { version: DOC_VERSION, feeds, read, annotations };
}

/** Merges two documents: the newest change wins per feed and per article; "read" can only be gained. */
export function mergeDocs(a, b, now = Date.now()) {
  const cutoff = now - KEEP_MS;
  const newest = (mapA, mapB) => {
    const out = { ...mapA };
    for (const [key, entry] of Object.entries(mapB)) {
      if (!out[key] || entry.at > out[key].at) out[key] = entry;
    }
    return out;
  };

  const feeds = newest(a.feeds, b.feeds);
  for (const [url, feed] of Object.entries(feeds)) {
    if (feed.removed && feed.at < cutoff) delete feeds[url];
  }

  const read = { ...a.read };
  for (const [key, at] of Object.entries(b.read)) read[key] = key in read ? Math.min(read[key], at) : at;
  for (const [key, at] of Object.entries(read)) {
    if (at < cutoff) delete read[key];
  }

  const annotations = newest(a.annotations, b.annotations);
  for (const [key, entry] of Object.entries(annotations)) {
    if (!hasAnnotation(entry) && entry.at < cutoff) delete annotations[key];
  }
  return { version: DOC_VERSION, feeds, read, annotations };
}

/** Applies a merged document to local data. Returns only the keys that changed, plus how many feeds are new. */
export function applyDoc(state, doc, now = Date.now()) {
  let working = { feeds: state.feeds, items: state.items, removedFeeds: state.removedFeeds || {} };
  let feedsChanged = false;
  let itemsChanged = false;
  let addedFeeds = 0;

  for (const [url, entry] of Object.entries(doc.feeds)) {
    const local = working.feeds.find((f) => f.url === url);
    if (entry.removed) {
      if (local && (local.addedAt || 0) <= entry.at) {
        working = { ...working, ...removeFeed(working, local, entry.at) };
        feedsChanged = true;
        itemsChanged = true;
      } else if (!local && working.removedFeeds[url] !== entry.at) {
        working = { ...working, removedFeeds: { ...working.removedFeeds, [url]: entry.at } };
        feedsChanged = true;
      }
    } else if (!local) {
      const feed = {
        id: crypto.randomUUID(),
        url,
        title: entry.title,
        siteUrl: entry.siteUrl,
        icon: entry.icon,
        addedAt: entry.at,
        lastError: '',
      };
      const { [url]: _tombstone, ...removedFeeds } = working.removedFeeds;
      working = { ...working, feeds: [...working.feeds, feed], removedFeeds };
      addedFeeds++;
      feedsChanged = true;
    }
  }

  const seen = new Set();
  const items = working.items.map((item) => {
    const key = itemKey(item);
    seen.add(key);
    let next = item;
    if (!item.read && key in doc.read) next = { ...next, read: true };
    const entry = doc.annotations[key];
    if (entry && entry.at > (item.annotatedAt || 0)) {
      next = { ...next, favorite: entry.favorite, tags: entry.tags, note: entry.note, annotatedAt: entry.at };
    }
    if (next !== item) itemsChanged = true;
    return next;
  });

  // Annotated articles this device does not have, e.g. already gone from the feed.
  for (const [key, entry] of Object.entries(doc.annotations)) {
    if (seen.has(key) || !hasAnnotation(entry)) continue;
    const feed = working.feeds.find((f) => f.url === entry.feedUrl);
    items.push({
      id: `${feed?.id || 'orphan'}|${key}`,
      feedId: feed?.id || 'orphan',
      guid: key,
      title: entry.title,
      link: entry.link,
      date: entry.date || now,
      author: entry.author,
      image: entry.image,
      html: '',
      read: key in doc.read,
      favorite: entry.favorite,
      tags: entry.tags,
      note: entry.note,
      annotatedAt: entry.at,
      feedUrl: entry.feedUrl,
      feedTitle: entry.feedTitle,
    });
    itemsChanged = true;
  }

  const patch = {};
  if (feedsChanged) {
    patch.feeds = working.feeds;
    patch.removedFeeds = working.removedFeeds;
  }
  if (itemsChanged) patch.items = items;
  return { patch, addedFeeds };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function serializeDoc(doc) {
  return JSON.stringify(canonical(doc));
}

function parseRemote(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(t('syncCorrupt'));
  }
  if (doc.version > DOC_VERSION) throw new Error(t('syncNewer'));
  if (!doc.feeds || !doc.read || !doc.annotations) throw new Error(t('syncInvalid'));
  return doc;
}

/**
 * One full sync: download, merge, apply locally, upload if something changed.
 * Local state is read after each download, with no await before it is saved, so concurrent edits are not lost.
 * If another device writes first, the upload is refused and the whole cycle runs again.
 */
export async function runSync(provider, getState, applyPatch, now = Date.now()) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { text, rev } = await provider.read();
    const remote = text === null ? null : parseRemote(text);
    const state = getState();
    const local = buildLocalDoc(state, now);
    const merged = mergeDocs(local, remote || local, now);
    const { patch, addedFeeds } = applyDoc(state, merged, now);
    if (Object.keys(patch).length) await applyPatch(patch);

    const body = serializeDoc(merged);
    if (remote && body === serializeDoc(remote)) return { addedFeeds, uploaded: false };
    try {
      await provider.write(body, rev);
      return { addedFeeds, uploaded: true };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  throw new Error(t('syncBusy'));
}
