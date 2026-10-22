// App-wide state: server status, Claude Code session, recent repos, banner.
import { api } from './api.js';
import { $, fill, h, modelLabel } from './dom.js';

export const state = { status: null, recentRepos: [] };

export const canRun = () => Boolean(state.status?.claude.loggedIn);

export function showBanner(title, text, kind = 'warn') {
  const banner = $('#banner');
  banner.className = `banner${kind === 'error' ? ' error' : ''}`;
  fill(banner, h('strong', {}, title), text ? h('p', {}, text) : null);
  banner.hidden = false;
}

export function renderStatus() {
  const { claude, config } = state.status;
  $('#model-pill').textContent = modelLabel(config.model);
  const plan = claude.subscriptionType ? ` · ${claude.subscriptionType[0].toUpperCase()}${claude.subscriptionType.slice(1)}` : '';
  $('#session-pill').textContent = claude.loggedIn ? `Claude Code${plan}` : '';
  $('#session-pill').title = claude.loggedIn ? `Reviews run on your Claude Code session (${claude.path}, ${claude.version})` : '';
  if (!claude.loggedIn) {
    showBanner(
      claude.found ? 'Claude Code is not logged in' : 'Claude Code is not installed',
      `${claude.error} Reviews run on your local Claude Code session. You can still browse past reports. Reload this page once it's set up.`,
    );
  } else {
    $('#banner').hidden = true;
  }
}

export async function loadStatus() {
  state.status = await api('/api/status');
  renderStatus();
  return state.status;
}

export async function loadRecentRepos() {
  const { repos } = await api('/api/repos/recent');
  state.recentRepos = repos;
  return repos;
}
