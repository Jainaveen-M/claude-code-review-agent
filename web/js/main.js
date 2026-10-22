// Entry point: token, status, and a tiny hash router.
//   #/new                 wizard
//   #/run/<id>            live review
//   #/report/<id>[/tab]   report (overview | code | brd)
//   #/history             dashboard
import { initToken } from './api.js';
import { $, $$ } from './dom.js';
import { render as renderHistory } from './history.js';
import { render as renderReport } from './report.js';
import { render as renderRun } from './run.js';
import { initSettings } from './settings.js';
import { initTheme } from './theme.js';
import { loadRecentRepos, loadStatus, showBanner, state } from './store.js';
import { render as renderWizard } from './wizard.js';

let cleanup = null;

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = $('#view');
  cleanup?.();
  cleanup = null;
  let nav = 'new';
  if (parts[0] === 'run' && parts[1]) {
    cleanup = renderRun(view, { id: parts[1] });
  } else if (parts[0] === 'report' && parts[1]) {
    nav = 'history';
    cleanup = renderReport(view, { id: parts[1], tab: parts[2] });
  } else if (parts[0] === 'history') {
    nav = 'history';
    cleanup = renderHistory(view);
  } else {
    cleanup = renderWizard(view);
  }
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

async function init() {
  initTheme();
  if (!initToken()) {
    showBanner('Open this page from the terminal link', 'Run `code-review-agent ui` and open the URL it prints. It includes an access token.', 'error');
    return;
  }
  initSettings();
  try {
    await Promise.all([loadStatus(), loadRecentRepos()]);
  } catch (error) {
    showBanner('Could not reach the server', error.message, 'error');
    return;
  }
  // A review still running (e.g. after a reload) takes precedence over the wizard.
  const active = state.status.activeRun;
  if (active && (!location.hash || location.hash === '#/new')) location.replace(`#/run/${active.id}`);
  window.addEventListener('hashchange', route);
  route();
}

init();
