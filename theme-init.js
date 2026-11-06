// Runs before the first paint, so a saved theme does not flash the other one while storage loads.
try {
  const theme = localStorage.getItem('theme');
  if (theme) document.documentElement.dataset.theme = theme;
} catch {
  // Without storage the panel follows the system until panel.js applies the preference.
}
