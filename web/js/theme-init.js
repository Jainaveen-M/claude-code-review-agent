// Loaded as a blocking classic script in <head>, so the right theme is set before
// the first paint (no flash of light colours on a dark system, or vice versa).
(function () {
  var choice = 'system';
  try {
    choice = localStorage.getItem('cra-theme') || 'system';
  } catch (e) {
    // storage blocked: follow the system
  }
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
