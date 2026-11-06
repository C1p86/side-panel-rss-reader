/** Translated text from _locales. Browser languages without a translation fall back to English. */
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
}

export function uiLanguage() {
  return chrome.i18n.getUILanguage();
}

/** Fills the page's static text from its data-i18n attributes and sets the reading direction. */
export function applyTranslations() {
  document.documentElement.lang = uiLanguage();
  document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
}
