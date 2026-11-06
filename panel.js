import { canUseFeeder, fetchDecoded, findFeedLink, findFeedViaFeeder, findSiteIcon, mergeItems, parseFeed, safeUrl } from './feeds.js';
import { extractArticle, fetchRenderedHtml, findPageImage, sanitize, textLength } from './reader.js';
import { applyTranslations, t, uiLanguage } from './i18n.js';
import { removeFeed, runSync } from './sync.js';
import { connectGithub, createProvider, finishDropboxAuth, startDropboxAuth } from './sync-providers.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MIN_ARTICLE_LENGTH = 500; // Below this, an extraction is probably a teaser or a consent wall.

const $ = (id) => document.getElementById(id);
const DEFAULTS = { feeds: [], items: [], removedFeeds: {}, prefs: { tag: '', unreadOnly: false, favoritesOnly: false, theme: 'system', feederLookup: 'ask' } };
const ALL_FEEDS = 'all';
const FAVORITES = 'favorites';
const ALL_FEEDS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l2.500-8h11l2.500 8v6H4zM4 13h5l1.500 3h3l1.500-3h5"/></svg>';
const SYNC_DELAY_MS = 30000; // Groups a burst of changes into one upload (on GitHub, one commit).
const NOTE_SAVE_DELAY_MS = 500;
const TOAST_MS = 2500;
const MAX_TAG_SUGGESTIONS = 8;
const MAX_IMAGE_LOOKUPS = 3;
const IMAGE_SAVE_DELAY_MS = 600;
const FEED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h.01M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.500 2.600 5.400 5.900.8-4.300 4.100 1 5.900-5.200-2.800-5.200 2.800 1-5.900-4.300-4.100 5.900-.8z"/></svg>';
const numberFormat = new Intl.NumberFormat(uiLanguage());
const dateFormat = new Intl.DateTimeFormat(uiLanguage(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let state = structuredClone(DEFAULTS);
let currentFeed = ALL_FEEDS; // What the list page shows: a feed id, ALL_FEEDS or FAVORITES.
let currentItem = null; // Article shown in the reader; also discards late responses for older clicks.
let pendingWrites = 0;
let noteTimer;
let toastTimer;
const articleCache = new Map();
const searchIndex = new WeakMap(); // Items are replaced when they change, so entries never go stale.
const rowCache = new Map(); // Item id -> rendered row: reusing rows avoids reloading every thumbnail.
const imageQueue = [];
const imageAttempted = new Set();
const imagePatches = new Map();
const iconAttempted = new Set();
let activeImageLookups = 0;
let imageSaveTimer;
let syncConfig = null; // Credentials: kept apart from the synced data, and never uploaded.
let syncProvider = null;
let syncTimer;
let syncRunning = false;
let syncAgain = false;
let dropboxVerifier = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function save(patch, { fromSync = false } = {}) {
  Object.assign(state, patch);
  pendingWrites++;
  try {
    await chrome.storage.local.set(patch); // The list re-renders from storage.onChanged.
  } finally {
    pendingWrites--;
  }
  if (!fromSync && (patch.feeds || patch.items)) scheduleSync();
}

function updateItem(itemId, patch) {
  // The timestamp decides which device wins when the same article is annotated on two of them.
  const annotated = 'favorite' in patch || 'tags' in patch || 'note' in patch;
  const stamped = annotated ? { ...patch, annotatedAt: Date.now() } : patch;
  return save({ items: state.items.map((i) => (i.id === itemId ? { ...i, ...stamped } : i)) });
}

function showView(id) {
  for (const view of ['home-view', 'list-view', 'manage-view', 'reader-view']) $(view).hidden = view !== id;
}

function feedName(item) {
  return state.feeds.find((f) => f.id === item.feedId)?.title || item.feedTitle || '';
}

function feedIcon(item) {
  return state.feeds.find((f) => f.id === item.feedId)?.icon || item.feedIcon || '';
}

function imageElement(className, src, fallback) {
  const img = el('img', className);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => img.replaceWith(...(fallback ? [fallback] : []))); // Never a broken image.
  img.src = src;
  return img;
}

function toggleFavorite(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (item) updateItem(itemId, { favorite: !item.favorite });
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, TOAST_MS);
}

function renderStar(button, item) {
  const favorite = Boolean(item.favorite);
  button.setAttribute('aria-pressed', String(favorite));
  button.title = t(favorite ? 'removeFavorite' : 'addFavorite');
}

/* ---------- List ---------- */

// Accent-insensitive, so "cafe" finds "café".
function normalize(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function searchableText(item) {
  let text = searchIndex.get(item);
  if (text === undefined) {
    const feedText = (item.html || '').replace(/<[^>]*>/g, ' ');
    text = normalize([item.title, item.author, feedName(item), ...(item.tags || []), item.note, feedText].join(' '));
    searchIndex.set(item, text);
  }
  return text;
}

function allTags() {
  const counts = new Map();
  for (const item of state.items) {
    for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b, uiLanguage()));
}

function inCurrentList(item) {
  return currentFeed === ALL_FEEDS || (currentFeed === FAVORITES ? item.favorite : item.feedId === currentFeed);
}

/** The chosen tag, unless no article of the open list has it (any more). */
function activeTag() {
  const { tag } = state.prefs;
  return tag && state.items.some((i) => inCurrentList(i) && i.tags?.includes(tag)) ? tag : '';
}

function visibleItems() {
  const tag = activeTag();
  const { unreadOnly, favoritesOnly } = state.prefs;
  const terms = normalize($('search').value).split(/\s+/).filter(Boolean);
  return state.items
    .filter(inCurrentList)
    .filter((i) => !tag || i.tags?.includes(tag))
    .filter((i) => !(unreadOnly && i.read))
    .filter((i) => !favoritesOnly || i.favorite)
    .filter((i) => terms.every((term) => searchableText(i).includes(term)))
    .sort((a, b) => b.date - a.date);
}

function renderTagFilter() {
  const focused = document.activeElement?.dataset?.tagFilter; // Rebuilding the chips loses keyboard focus.
  const tag = activeTag();
  const tags = [...new Set(state.items.filter(inCurrentList).flatMap((i) => i.tags || []))]
    .sort((a, b) => a.localeCompare(b, uiLanguage()));
  $('tag-filter').replaceChildren(
    ...tags.map((name) => {
      const chip = el('button', 'tag-chip', name);
      chip.type = 'button';
      chip.dataset.tagFilter = name;
      chip.setAttribute('aria-pressed', String(name === tag));
      chip.addEventListener('click', () => save({ prefs: { ...state.prefs, tag: name === tag ? '' : name } }));
      return chip;
    }),
  );
  $('tag-filter').hidden = !tags.length;
  if (focused) document.querySelector(`[data-tag-filter="${CSS.escape(focused)}"]`)?.focus();
}

function svgIcon(markup) {
  return document.createRange().createContextualFragment(markup);
}

/** A first-page button with its "to read/total" counter. */
function homeButton(className, key, onOpen, items, ...content) {
  const unread = items.filter((i) => !i.read).length;
  const [unreadText, totalText] = [unread, items.length].map((value) => numberFormat.format(value));
  const count = el('span', 'feed-count', `${unreadText}/${totalText}`);
  count.title = t('unreadOf', unreadText, totalText);
  const button = el('button', `${className}${unread ? ' has-unread' : ''}`);
  button.type = 'button';
  button.dataset.feedEntry = key;
  button.append(...content, count);
  button.addEventListener('click', onOpen);
  const li = el('li');
  li.append(button);
  return li;
}

function homeEntry(key, title, icon, onOpen, items) {
  const iconBox = el('span', 'feed-entry-icon');
  if (icon instanceof HTMLImageElement) icon.loading = 'eager'; // These rows are rebuilt often and few: no lazy gaps.
  iconBox.append(icon);
  return homeButton('feed-entry', key, onOpen, items, iconBox, el('span', 'feed-entry-title', title));
}

function renderHome() {
  const focused = document.activeElement?.dataset?.feedEntry; // Rebuilding the rows loses keyboard focus.
  const hasContent = state.feeds.length || state.items.length;
  $('home-feeds').replaceChildren(
    ...(hasContent ? [
      homeEntry(ALL_FEEDS, t('allFeeds'), svgIcon(ALL_FEEDS_SVG), () => openList(ALL_FEEDS), state.items),
      homeEntry(FAVORITES, t('favorites'), svgIcon(STAR_SVG), () => openList(FAVORITES), state.items.filter((i) => i.favorite)),
    ] : []),
    ...state.feeds.map((feed) =>
      homeEntry(feed.id, feed.title, feed.icon ? imageElement('favicon', feed.icon, svgIcon(FEED_SVG)) : svgIcon(FEED_SVG), () => openList(feed.id),
        state.items.filter((i) => i.feedId === feed.id))),
  );
  const tags = allTags();
  $('home-tag-list').replaceChildren(
    ...tags.map(([tag]) => homeButton('tag-chip', `tag:${tag}`, () => openList(ALL_FEEDS, tag),
      state.items.filter((i) => i.tags?.includes(tag)), el('span', 'tag-chip-label', tag))),
  );
  $('home-tags').hidden = !tags.length;
  if (focused) document.querySelector(`[data-feed-entry="${CSS.escape(focused)}"]`)?.focus();
  $('home-search-bar').hidden = !hasContent;
  $('home-empty').hidden = Boolean(hasContent);

  const failed = state.feeds.filter((f) => f.lastError);
  $('feed-errors').hidden = !failed.length;
  $('feed-errors').textContent = failed.length ? t('updateFailed', failed.map((f) => f.title).join(', ')) : '';
}

/** Opens the article list from the first page, without a search or tag left over from the previous visit. */
function openList(feedId, tag = '') {
  currentFeed = feedId;
  $('search').value = '';
  if (state.prefs.tag !== tag) save({ prefs: { ...state.prefs, tag } });
  renderTagFilter();
  renderItems();
  showView('list-view');
  $('items').scrollTop = 0;
}

function rowSignature(item) {
  return JSON.stringify([
    item.title, item.link, item.date, item.read, Boolean(item.favorite), item.tags,
    Boolean(item.note?.trim()), item.image, feedName(item), feedIcon(item),
  ]);
}

function buildRow(item) {
  const body = el('span', 'item-body');
  const meta = el('span', 'item-meta');
  if (feedIcon(item)) meta.append(imageElement('favicon', feedIcon(item)));
  meta.append(`${feedName(item)} · ${dateFormat.format(item.date)}`);
  const title = el('span', 'item-title', item.title || item.link || t('untitled'));
  title.dir = 'auto'; // Articles keep their own language, whatever the interface language is.
  body.append(title, meta);
  if (item.tags?.length || item.note?.trim()) {
    const chips = el('span', 'chips');
    if (item.note?.trim()) chips.append(el('span', 'chip has-note', t('note')));
    for (const tag of item.tags || []) chips.append(el('span', 'chip', tag));
    body.append(chips);
  }

  const row = el('button', `item ${item.read ? 'read' : 'unread'}`);
  row.type = 'button';
  if (item.image) row.append(imageElement('thumb', item.image));
  row.append(body);
  row.addEventListener('click', () => openArticle(item.id));

  const star = el('button', 'icon star');
  star.type = 'button';
  star.innerHTML = STAR_SVG;
  star.dataset.starFor = item.id;
  star.setAttribute('aria-label', t('favoriteOf', item.title || item.link || ''));
  renderStar(star, item);
  star.addEventListener('click', () => toggleFavorite(item.id));

  const li = el('li', 'item-row');
  li.dataset.itemId = item.id;
  li.append(row, star);
  if (!item.image && !item.imageChecked && item.link) imageObserver.observe(li);
  return li;
}

/* Rows whose feed has no image get one from the page, but only once they scroll into view. */
const imageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    imageObserver.unobserve(entry.target);
    const id = entry.target.dataset.itemId;
    if (imageAttempted.has(id)) continue;
    imageAttempted.add(id);
    imageQueue.push(id);
  }
  pumpImageLookups();
}, { root: $('items'), rootMargin: '300px' });

function pumpImageLookups() {
  while (activeImageLookups < MAX_IMAGE_LOOKUPS && imageQueue.length) {
    activeImageLookups++;
    lookUpPageImage(imageQueue.shift()).finally(() => {
      activeImageLookups--;
      pumpImageLookups();
    });
  }
}

async function lookUpPageImage(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item?.link) return;
  try {
    const { text, url } = await fetchDecoded(item.link);
    imagePatches.set(itemId, { image: findPageImage(text, url), imageChecked: true });
  } catch {
    return; // Network errors may be temporary: try again the next time the panel opens.
  }
  // Results arrive in bursts while scrolling, so they are written together.
  clearTimeout(imageSaveTimer);
  imageSaveTimer = setTimeout(() => {
    const patches = new Map(imagePatches);
    imagePatches.clear();
    save({ items: state.items.map((i) => (patches.has(i.id) ? { ...i, ...patches.get(i.id) } : i)) });
  }, IMAGE_SAVE_DELAY_MS);
}

function renderItems() {
  const tag = activeTag();
  const showingFavorites = currentFeed === FAVORITES;
  $('list-title').textContent = state.feeds.find((f) => f.id === currentFeed)?.title
    || (showingFavorites && t('favorites'))
    || (tag ? t('tagTitle', tag) : t('allFeeds'));
  $('favorites-only').parentElement.hidden = showingFavorites; // On this page the filter would do nothing.
  const visible = visibleItems();
  const focusedStar = document.activeElement?.dataset?.starFor; // Moving rows in the DOM loses keyboard focus.

  $('items').replaceChildren(
    ...visible.map((item) => {
      const signature = rowSignature(item);
      const cached = rowCache.get(item.id);
      if (cached?.signature === signature) return cached.li;
      const li = buildRow(item);
      rowCache.set(item.id, { signature, li });
      return li;
    }),
  );
  if (focusedStar) {
    [...document.querySelectorAll('[data-star-for]')].find((s) => s.dataset.starFor === focusedStar)?.focus();
  }

  const filtered = $('search').value.trim() || tag || state.prefs.unreadOnly
    || (state.prefs.favoritesOnly && !showingFavorites);
  const empty = $('empty');
  empty.hidden = visible.length > 0;
  if (filtered) empty.textContent = t('noMatch');
  else empty.textContent = t(showingFavorites ? 'noFavorites' : 'noArticles');
}

function renderFeeds() {
  $('feeds').replaceChildren(
    ...state.feeds.map((feed) => {
      const li = el('li', 'feed-row');
      const info = el('div', 'feed-info');
      const title = el('div', 'feed-title');
      if (feed.icon) title.append(imageElement('favicon', feed.icon));
      title.append(feed.title);
      info.append(title, el('div', 'feed-url', feed.url));
      if (feed.lastError) info.append(el('div', 'feed-error', feed.lastError));
      const remove = el('button', 'link', t('remove'));
      remove.type = 'button';
      // Articles with favorites, tags or notes outlive their feed, so that data is never lost by accident.
      remove.addEventListener('click', () => save(removeFeed(state, feed)));
      li.append(info, remove);
      return li;
    }),
  );
}

function applyTheme() {
  const theme = state.prefs.theme || 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', theme); // Read by theme-init.js at the next opening.
  } catch {
    // Only the flash protection is lost: the theme itself lives in the preferences.
  }
  document.querySelector(`input[name="theme"][value="${theme}"]`).checked = true;
}

function render() {
  applyTheme();
  document.querySelector(`input[name="feeder-lookup"][value="${state.prefs.feederLookup || 'ask'}"]`).checked = true;
  $('unread-only').checked = Boolean(state.prefs.unreadOnly);
  $('favorites-only').checked = Boolean(state.prefs.favoritesOnly);
  // The open feed can disappear while its page is showing: sync or another window may remove it.
  if (currentFeed !== ALL_FEEDS && currentFeed !== FAVORITES && !state.feeds.some((f) => f.id === currentFeed)) {
    currentFeed = ALL_FEEDS;
    if (!$('list-view').hidden) showView('home-view');
  }
  renderHome();
  renderTagFilter();
  renderItems();
  renderFeeds();
  renderAnnotations();
}

/* ---------- Feeds ---------- */

/** Looks up the icon of feeds that do not have one yet. Runs in the background and never blocks the list. */
async function loadMissingIcons() {
  const missing = state.feeds.filter((f) => !f.icon && !iconAttempted.has(f.id));
  if (!missing.length) return;
  missing.forEach((f) => iconAttempted.add(f.id));
  const icons = new Map(
    await Promise.all(
      missing.map(async (feed) => {
        const site = feed.siteUrl || feed.url;
        try {
          const { text, url } = await fetchDecoded(site);
          return [feed.id, findSiteIcon(text, url)];
        } catch {
          return [feed.id, new URL('/favicon.ico', site).href];
        }
      }),
    ),
  );
  await save({ feeds: state.feeds.map((f) => (icons.has(f.id) ? { ...f, icon: icons.get(f.id) } : f)) });
}

async function refreshAll() {
  const buttons = document.querySelectorAll('.refresh');
  if (buttons[0].classList.contains('busy')) return;
  buttons.forEach((button) => button.classList.add('busy'));
  try {
    const results = new Map(
      await Promise.all(
        state.feeds.map(async (feed) => {
          try {
            const { text, url } = await fetchDecoded(feed.url);
            return [feed.id, { parsed: parseFeed(text, url) }];
          } catch (error) {
            return [feed.id, { error: error.message }];
          }
        }),
      ),
    );
    // Reload from storage: during the fetches, another window may have changed feeds or read flags.
    const fresh = await chrome.storage.local.get({ feeds: [], items: [] });
    const feeds = fresh.feeds.map((feed) => {
      const result = results.get(feed.id);
      if (!result) return feed;
      return result.error
        ? { ...feed, lastError: result.error }
        : { ...feed, title: result.parsed.title, siteUrl: result.parsed.siteUrl, lastError: '' };
    });
    const feedIds = new Set(feeds.map((feed) => feed.id));
    const items = [
      ...feeds.flatMap((feed) => {
        const existing = fresh.items.filter((i) => i.feedId === feed.id);
        const parsed = results.get(feed.id)?.parsed;
        return parsed ? mergeItems(feed.id, parsed.items, existing) : existing;
      }),
      ...fresh.items.filter((i) => !feedIds.has(i.feedId)), // Annotated articles of removed feeds.
    ];
    await save({ feeds, items });
    loadMissingIcons();
  } finally {
    buttons.forEach((button) => button.classList.remove('busy'));
  }
}

async function loadFeed(feedUrl) {
  const response = await fetchDecoded(feedUrl);
  return { feedUrl, parsed: parseFeed(response.text, response.url) };
}

function askAboutFeeder() {
  $('feeder-remember').checked = false;
  $('feeder-prompt').hidden = false;
  $('feeder-yes').focus();
  return new Promise((resolve) => {
    const answer = (accepted) => {
      $('feeder-prompt').hidden = true;
      resolve({ accepted, remember: $('feeder-remember').checked });
    };
    $('feeder-yes').onclick = () => answer(true);
    $('feeder-no').onclick = () => answer(false);
  });
}

/** The address leaves the browser only with the user's consent, given now or saved in the options. */
async function mayUseFeeder(url) {
  if (!canUseFeeder(url)) return false;
  const choice = state.prefs.feederLookup || 'ask';
  if (choice !== 'ask') return choice === 'always';
  const { accepted, remember } = await askAboutFeeder();
  if (remember) await save({ prefs: { ...state.prefs, feederLookup: accepted ? 'always' : 'never' } });
  return accepted;
}

/** Tries the address itself, then the feed its page declares, and only then offers Feeder. */
async function resolveFeed(url) {
  let localError;
  try {
    const response = await fetchDecoded(url);
    try {
      return { feedUrl: url, parsed: parseFeed(response.text, response.url) };
    } catch {
      const declared = findFeedLink(response.text, response.url);
      if (declared) return await loadFeed(declared);
      localError = new Error(t('errNoFeed'));
    }
  } catch (error) {
    localError = error;
  }
  if (!(await mayUseFeeder(url))) throw localError;
  $('add-status').hidden = false;
  const found = await findFeedViaFeeder(url).catch(() => '');
  $('add-status').hidden = true;
  if (!found) throw new Error(t('errFeederNone'));
  return loadFeed(found);
}

async function addFeed(input) {
  // A digit after the colon is a port ("example.com:8080"), not a scheme.
  const url = safeUrl(/^[a-z][a-z\d+.-]*:(?!\d)/i.test(input) ? input : `https://${input}`);
  if (!url) throw new Error(t('errInvalidUrl'));

  const { feedUrl, parsed } = await resolveFeed(url);
  if (state.feeds.some((f) => f.url === feedUrl)) throw new Error(t('errDuplicate'));

  const feed = { id: crypto.randomUUID(), url: feedUrl, title: parsed.title, siteUrl: parsed.siteUrl, lastError: '', addedAt: Date.now() };
  const { [feedUrl]: _removed, ...removedFeeds } = state.removedFeeds || {};
  await save({
    removedFeeds,
    feeds: [...state.feeds, feed],
    items: [...state.items, ...mergeItems(feed.id, parsed.items, [])],
  });
  loadMissingIcons();
}

/* ---------- Sync ---------- */

function syncStatus(message, isError = false) {
  $('sync-status').textContent = message;
  $('sync-status').hidden = !message;
  $('sync-status').classList.toggle('error', isError);
}

function renderSync() {
  const connected = Boolean(syncConfig);
  const chosen = $('sync-provider').value;
  $('sync-setup').hidden = connected;
  $('sync-connected').hidden = !connected;
  $('dropbox-form').hidden = chosen !== 'dropbox';
  $('github-form').hidden = chosen !== 'github';
  if (syncConfig) {
    $('sync-target').textContent = syncConfig.provider === 'dropbox'
      ? t('connectedDropbox')
      : t('connectedGithub', syncConfig.repo);
  }
}

function scheduleSync() {
  if (!syncConfig) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, SYNC_DELAY_MS);
}

async function syncNow() {
  if (!syncConfig) return;
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  clearTimeout(syncTimer);
  syncRunning = true;
  $('sync-now').disabled = true;
  syncStatus(t('syncing'));
  try {
    const { addedFeeds } = await runSync(syncProvider, () => state, (patch) => save(patch, { fromSync: true }));
    syncStatus(t('lastSync', dateFormat.format(Date.now())));
    if (addedFeeds) refreshAll(); // Feeds from another device have no articles here yet.
  } catch (error) {
    syncStatus(t('syncFailed', error.message), true);
  } finally {
    syncRunning = false;
    $('sync-now').disabled = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync();
    }
  }
}

async function connectSync(config) {
  await chrome.storage.local.set({ syncConfig: config });
  syncConfig = config;
  syncProvider = createProvider(config);
  renderSync();
  await syncNow();
}

async function connectFrom(form, makeConfig) {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  syncStatus('');
  try {
    await connectSync(await makeConfig());
    form.reset();
  } catch (error) {
    syncStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

/* ---------- Annotations ---------- */

/** While typing a tag, offers the tags already used elsewhere that match and are not on this article. */
function renderTagSuggestions() {
  const box = $('tag-suggestions');
  const item = state.items.find((i) => i.id === currentItem);
  if (!item || document.activeElement !== $('tag-input')) {
    box.hidden = true;
    return;
  }
  const parts = $('tag-input').value.split(',');
  const typed = normalize(parts.pop().trim());
  const options = allTags()
    .map(([tag]) => tag)
    .filter((tag) => !item.tags?.includes(tag) && normalize(tag).includes(typed))
    .slice(0, MAX_TAG_SUGGESTIONS);
  box.replaceChildren(
    ...options.map((tag) => {
      const chip = el('button', 'tag-chip suggestion', `+ ${tag}`);
      chip.type = 'button';
      chip.setAttribute('aria-label', t('addTagNamed', tag));
      chip.addEventListener('click', () => {
        addTags([...parts, tag].join(','));
        $('tag-input').value = '';
        renderTagSuggestions();
      });
      return chip;
    }),
  );
  box.hidden = !options.length;
}

function renderAnnotations() {
  renderTagSuggestions();
  const item = state.items.find((i) => i.id === currentItem);
  if (!item) return;
  renderStar($('favorite'), item);
  $('article-tags').replaceChildren(
    ...(item.tags || []).map((tag) => {
      const chip = el('li', 'chip', tag);
      const remove = el('button', '', '×');
      remove.type = 'button';
      remove.title = t('removeTagNamed', tag);
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () =>
        updateItem(item.id, { tags: item.tags.filter((t) => t !== tag) }));
      chip.append(remove);
      return chip;
    }),
  );
}

function addTags(raw) {
  const item = state.items.find((i) => i.id === currentItem);
  if (!item) return;
  const typed = raw.split(',').map((tag) => tag.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
  if (!typed.length) return; // Otherwise an empty Enter would count as a new annotation for sync.
  const tags = [...new Set([...(item.tags || []), ...typed])];
  updateItem(item.id, { tags });
}

function flushNote() {
  clearTimeout(noteTimer);
  const item = state.items.find((i) => i.id === currentItem);
  if (item && (item.note || '') !== $('note').value) updateItem(item.id, { note: $('note').value });
}

/* ---------- Share ---------- */

function closeShareMenu() {
  $('share-menu').hidden = true;
  $('share').setAttribute('aria-expanded', 'false');
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // The async clipboard requires a focused document, which a web panel may not be.
    const area = el('textarea');
    area.value = url;
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

async function shareTo(target) {
  closeShareMenu();
  const item = state.items.find((i) => i.id === currentItem);
  if (!item?.link) return;
  const url = encodeURIComponent(item.link);
  const title = encodeURIComponent(item.title || '');
  if (target === 'copy') {
    toast(t((await copyLink(item.link)) ? 'linkCopied' : 'copyFailed'));
  } else if (target === 'system') {
    try {
      await navigator.share({ title: item.title, url: item.link });
    } catch (error) {
      if (error.name !== 'AbortError') toast(t('shareUnavailable'));
    }
  } else if (target === 'whatsapp') {
    chrome.tabs.create({ url: `https://wa.me/?text=${title}%20${url}` });
  } else if (target === 'telegram') {
    chrome.tabs.create({ url: `https://t.me/share/url?url=${url}&text=${title}` });
  } else if (target === 'email') {
    chrome.tabs.create({ url: `mailto:?subject=${title}&body=${url}` });
  }
}

/* ---------- Reader ---------- */

// Some players refuse to run inside an extension page, so each one also gets a way out.
function addVideoLinks(root) {
  for (const frame of root.querySelectorAll('iframe')) {
    const box = el('div', 'video-embed');
    frame.replaceWith(box);
    const link = el('a', 'video-link', t('openVideo'));
    link.href = frame.src.replace(/\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]+).*/, '//www.youtube.com/watch?v=$1');
    box.append(frame, link);
  }
}

function showArticle(item, { title, meta, html, notice }) {
  if (currentItem !== item.id) return;
  $('article-title').textContent = title;
  $('article-meta').textContent = meta;
  if (feedIcon(item)) $('article-meta').prepend(imageElement('favicon', feedIcon(item)));
  const template = document.createElement('template');
  template.innerHTML = html; // Always the output of sanitize().
  addVideoLinks(template.content);
  $('article-content').replaceChildren(template.content);
  $('article-notice').textContent = notice || '';
  $('article-notice').hidden = !notice;
  $('article-loading').hidden = true;
}

/** Some pages declare "Nov 4, 2026 by Jon Davis" or "By Jon Davis" as the author: keep only the name. */
function cleanByline(byline) {
  return byline?.trim().replace(/^(?:.*\d[,\s]+)?by\s+/i, '');
}

function presentation(item, article, problem) {
  const feedHtml = sanitize(item.html);
  const feedLength = textLength(feedHtml);
  const length = article?.length || 0;
  const good = length >= MIN_ARTICLE_LENGTH && length >= feedLength * 0.7;
  const useArticle = length >= feedLength && length > 0;

  let notice = '';
  if (!good) {
    const reason = problem || t('littleText');
    const hint = item.link ? ` ${t('hintRetry')}` : '';
    if (useArticle) notice = `${reason} ${t('textIncomplete')}${hint}`;
    else if (feedLength) notice = `${reason} ${t('feedTextShown')}${hint}`;
    else notice = `${reason} ${t('noText')}${hint}`;
  }

  const parts = [
    (useArticle && article.siteName) || feedName(item),
    (useArticle && cleanByline(article.byline)) || item.author,
    dateFormat.format(item.date),
  ];
  return {
    title: item.title || (useArticle && article.title) || t('untitled'),
    meta: [...new Set(parts.filter(Boolean))].join(' · '),
    html: useArticle ? article.content : feedHtml,
    notice,
  };
}

async function openArticle(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;
  currentItem = item.id;
  if (!item.read) updateItem(item.id, { read: true });

  renderAnnotations();
  $('tag-input').value = '';
  $('note').value = item.note || '';
  $('note-box').open = Boolean(item.note?.trim());
  $('share').hidden = !item.link;

  showView('reader-view');
  $('reader-scroll').scrollTop = 0;
  $('article-title').textContent = item.title;
  $('article-meta').textContent = '';
  $('article-content').replaceChildren();
  $('article-notice').hidden = true;
  $('article-loading').hidden = false;
  $('render-tab').disabled = !item.link;
  $('open-original').hidden = !item.link;
  $('open-original').href = item.link || '#';

  if (!item.link) {
    showArticle(item, presentation(item, null, t('noLink')));
    return;
  }
  let article = articleCache.get(item.id);
  let problem = '';
  if (!article) {
    try {
      const { text, url } = await fetchDecoded(item.link);
      article = extractArticle(text, url);
      if (article) articleCache.set(item.id, article);
    } catch (error) {
      problem = t('downloadFailed', error.message);
    }
  }
  showArticle(item, presentation(item, article, problem));
}

async function retryInBrowser() {
  const item = state.items.find((i) => i.id === currentItem);
  if (!item?.link) return;
  $('render-tab').disabled = true;
  $('article-notice').hidden = true;
  $('article-loading').hidden = false;
  let article = articleCache.get(item.id);
  let problem = '';
  try {
    const { html, url } = await fetchRenderedHtml(item.link);
    const rendered = extractArticle(html, url);
    // The user asked for this attempt because the first result looked wrong, so prefer it unless empty.
    if (rendered?.length >= MIN_ARTICLE_LENGTH || rendered?.length > (article?.length || 0)) {
      article = rendered;
      articleCache.set(item.id, article);
    }
  } catch (error) {
    problem = t('browserLoadFailed', error.message);
  }
  if (currentItem === item.id) $('render-tab').disabled = false;
  showArticle(item, presentation(item, article, problem));
}

/* ---------- Events ---------- */

function goBack() {
  if ($('reader-view').hidden) {
    showView('home-view');
    return;
  }
  flushNote();
  closeShareMenu();
  currentItem = null;
  showView('list-view');
}

document.querySelectorAll('.back').forEach((button) => button.addEventListener('click', goBack));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('share-menu').hidden) closeShareMenu();
  else if ($('home-view').hidden) goBack();
});

$('search').addEventListener('input', renderItems);
// Results live in the article list: the first keystroke moves there and typing continues in its search box.
$('home-search').addEventListener('input', (event) => {
  const query = event.target.value;
  event.target.value = '';
  openList(ALL_FEEDS);
  $('search').value = query;
  renderItems();
  $('search').focus();
});
document.querySelectorAll('input[name="theme"]').forEach((radio) =>
  radio.addEventListener('change', () => save({ prefs: { ...state.prefs, theme: radio.value } })));
document.querySelectorAll('input[name="feeder-lookup"]').forEach((radio) =>
  radio.addEventListener('change', () => save({ prefs: { ...state.prefs, feederLookup: radio.value } })));
$('favorites-only').addEventListener('change', (event) =>
  save({ prefs: { ...state.prefs, favoritesOnly: event.target.checked } }));

$('favorite').innerHTML = STAR_SVG;
$('favorite').addEventListener('click', () => toggleFavorite(currentItem));

$('tag-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addTags($('tag-input').value);
  $('tag-input').value = '';
  renderTagSuggestions();
});
$('tag-input').addEventListener('focus', renderTagSuggestions);
$('tag-input').addEventListener('input', renderTagSuggestions);
$('tag-input').addEventListener('blur', renderTagSuggestions);
// Clicking a suggestion must not blur the input, or the suggestion would vanish before the click lands.
$('tag-suggestions').addEventListener('mousedown', (event) => event.preventDefault());

$('note').addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, NOTE_SAVE_DELAY_MS);
});
$('note').addEventListener('blur', flushNote);
window.addEventListener('pagehide', flushNote);

$('share-system').hidden = !navigator.share;
$('share').addEventListener('click', () => {
  const opening = $('share-menu').hidden;
  $('share-menu').hidden = !opening;
  $('share').setAttribute('aria-expanded', String(opening));
});
for (const target of ['copy', 'system', 'whatsapp', 'telegram', 'email']) {
  $(`share-${target}`).addEventListener('click', () => shareTo(target));
}
document.addEventListener('click', (event) => {
  if (!event.target.closest?.('#share, #share-menu')) closeShareMenu();
});

document.querySelectorAll('.refresh').forEach((button) => button.addEventListener('click', refreshAll));
$('open-manage').addEventListener('click', () => {
  showView('manage-view');
  $('add-url').focus();
});
$('unread-only').addEventListener('change', (event) =>
  save({ prefs: { ...state.prefs, unreadOnly: event.target.checked } }));
$('mark-all').addEventListener('click', () => {
  const visible = new Set(visibleItems().map((i) => i.id));
  save({ items: state.items.map((i) => (visible.has(i.id) ? { ...i, read: true } : i)) });
});

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('add-error').hidden = true;
  $('add-submit').disabled = true;
  try {
    await addFeed($('add-url').value.trim());
    $('add-url').value = '';
  } catch (error) {
    $('add-error').textContent = error.message;
    $('add-error').hidden = false;
  } finally {
    $('add-submit').disabled = false;
  }
});

$('render-tab').addEventListener('click', retryInBrowser);

$('sync-provider').addEventListener('change', () => {
  syncStatus('');
  renderSync();
});
$('dropbox-authorize').addEventListener('click', async () => {
  const appKey = $('dropbox-key').value.trim();
  if (!appKey) {
    syncStatus(t('needDropboxKey'), true);
    return;
  }
  syncStatus('');
  const { verifier, url } = await startDropboxAuth(appKey);
  dropboxVerifier = verifier;
  chrome.tabs.create({ url });
});
$('dropbox-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connectFrom(event.target, () => {
    if (!dropboxVerifier) throw new Error(t('openAuthFirst'));
    return finishDropboxAuth($('dropbox-key').value.trim(), $('dropbox-code').value.trim(), dropboxVerifier);
  });
});
$('github-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connectFrom(event.target, () => connectGithub($('github-repo').value, $('github-token').value));
});
$('sync-now').addEventListener('click', syncNow);
$('sync-disconnect').addEventListener('click', async () => {
  clearTimeout(syncTimer);
  syncConfig = null;
  syncProvider = null;
  $('sync-provider').value = '';
  await chrome.storage.local.remove('syncConfig');
  syncStatus(t('disconnected'));
  renderSync();
});

// Open links in a normal tab: in a Vivaldi web panel they would otherwise navigate the panel.
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  const isFragment = link.getAttribute('href').startsWith('#');
  if (isFragment && link.id !== 'open-original') return;
  event.preventDefault();
  const url = safeUrl(link.href);
  if (url) chrome.tabs.create({ url });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((key) => key in DEFAULTS)) return;
  // While our own write is in flight, state is already newer than this event: applying it would undo changes.
  if (!pendingWrites) {
    for (const [key, change] of Object.entries(changes)) state[key] = change.newValue ?? DEFAULTS[key];
  }
  render();
});

applyTranslations();
state = await chrome.storage.local.get(DEFAULTS);
({ syncConfig = null } = await chrome.storage.local.get('syncConfig'));
if (syncConfig) syncProvider = createProvider(syncConfig);
render();
renderSync();
// Sync after the refresh, so read marks from other devices also reach the articles just downloaded.
refreshAll().then(syncNow);
setInterval(refreshAll, REFRESH_INTERVAL_MS);
