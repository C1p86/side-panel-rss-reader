/* global Readability, DOMPurify */
import { safeUrl } from './feeds.js';

const TAB_LOAD_TIMEOUT_MS = 25000;
const TAB_SETTLE_MS = 1500;

// Embeds kept in reader mode: known video hosts, plus URLs that declare themselves a player or video.
// Every other iframe (ads, comments, social widgets) is dropped.
const VIDEO_EMBED = /\/\/(?:[\w-]+\.)*(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|wikimedia\.org|archive\.org|v\.qq\.com|tiktok\.com|rumble\.com|streamable\.com|wistia\.(?:com|net)|brightcove\.net|jwplayer\.com|jwplatform\.com|kaltura\.com|rai\.it|raiplay\.it|mediaset\.it)\/|\/\/[^?#]*(?:player|video)/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IFRAME') {
    const raw = node.getAttribute('src') || '';
    const src = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!src.startsWith('https://') || !VIDEO_EMBED.test(src)) {
      node.remove();
      return;
    }
    node.setAttribute('src', src);
    node.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    node.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
    node.setAttribute('allowfullscreen', '');
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin'); // YouTube refuses embeds with no referrer.
  } else if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
    node.setAttribute('controls', '');
    node.setAttribute('preload', 'metadata');
    node.removeAttribute('autoplay');
  } else if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy');
  }
});

/** Strips anything active from third-party HTML before it enters the extension page. */
export function sanitize(html) {
  return DOMPurify.sanitize(html || '', {
    ADD_TAGS: ['iframe'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed'],
    FORBID_ATTR: ['style', 'class', 'id'],
  });
}

function pageImage(doc, baseUrl) {
  const node = doc.querySelector(
    'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[name="twitter:image:src"], meta[property="twitter:image"]',
  );
  const fromMeta = node?.getAttribute('content')
    || doc.querySelector('link[rel="image_src"]')?.getAttribute('href')
    || doc.querySelector('article img[src], main img[src]')?.getAttribute('src');
  return safeUrl(fromMeta, baseUrl);
}

/** Finds the image a page declares as its preview. */
export function findPageImage(html, url) {
  return pageImage(new DOMParser().parseFromString(html, 'text/html'), url);
}

/** Makes lazy-loaded media real, since a page's own lazy-loading script never runs here. */
function resolveLazyMedia(doc) {
  const attr = (node, ...names) => names.map((n) => node.getAttribute(n)).find(Boolean);
  for (const img of doc.querySelectorAll('img')) {
    const lazy = attr(img, 'data-src', 'data-lazy-src', 'data-original', 'data-url');
    const src = img.getAttribute('src') || '';
    if (lazy && (!src || src.startsWith('data:') || /placeholder|blank|spacer|lazy/i.test(src))) {
      img.setAttribute('src', lazy);
    }
    const srcset = attr(img, 'data-srcset', 'data-lazy-srcset');
    if (srcset) img.setAttribute('srcset', srcset);
  }
  for (const source of doc.querySelectorAll('source[data-srcset]')) {
    source.setAttribute('srcset', source.getAttribute('data-srcset'));
  }
  // Readability absolutizes images and videos but not iframes.
  for (const frame of doc.querySelectorAll('iframe')) {
    const src = attr(frame, 'data-src', 'data-lazy-src') || frame.getAttribute('src');
    const absolute = safeUrl(src?.startsWith('//') ? `https:${src}` : src, doc.baseURI);
    if (absolute) frame.setAttribute('src', absolute);
  }
}

export function textLength(html) {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim().length;
}

/** Runs Readability on a page's HTML. Returns null when no article can be extracted. */
export function extractArticle(html, url) {
  // DOMParser documents are inert: no scripts run and no images are loaded here.
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Readability resolves relative links against baseURI, which must be the page, not the extension.
  const pageBase = doc.querySelector('base[href]');
  const base = doc.createElement('base');
  base.href = new URL(pageBase?.getAttribute('href') || '', url).href;
  pageBase?.remove();
  doc.head.prepend(base);

  const leadImage = pageImage(doc, url); // Read first: Readability modifies the document.
  resolveLazyMedia(doc);

  const article = new Readability(doc, { allowedVideoRegex: VIDEO_EMBED }).parse();
  if (!article?.content) return null;
  const hasMedia = /<(img|video|iframe|picture)\b/i.test(article.content);
  const lead = !hasMedia && leadImage ? `<figure><img src="${leadImage.replace(/"/g, '%22')}" alt=""></figure>` : '';
  const content = sanitize(lead + article.content);
  return {
    title: article.title,
    byline: article.byline,
    siteName: article.siteName,
    content,
    length: textLength(content),
  };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    // On timeout, use whatever the page has rendered so far.
    const timer = setTimeout(finish, TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Loads the page in a temporary background tab and reads the rendered DOM.
 * Needed for pages built by JavaScript, or served differently to a plain fetch.
 */
export async function fetchRenderedHtml(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id);
    await new Promise((resolve) => setTimeout(resolve, TAB_SETTLE_MS));
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ html: document.documentElement.outerHTML, url: location.href }),
    });
    return injection.result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}
