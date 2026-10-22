// Folder browser dialog: lists folders from the local server and marks git repositories.
import { api } from './api.js';
import { $, fill, h, plural } from './dom.js';
import { state } from './store.js';

const LAST_FOLDER_KEY = 'cra-last-folder';
const folderState = { listing: null, scan: null, onSelect: null };
let wired = false;

export const parentDir = (p) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

function rememberFolder(path) {
  try { localStorage.setItem(LAST_FOLDER_KEY, path); } catch { /* storage blocked */ }
}

function lastFolder() {
  try { return localStorage.getItem(LAST_FOLDER_KEY); } catch { return null; }
}

function message(text) {
  fill($('#folder-list'), h('li', { class: 'message' }, text));
}

function select(path) {
  $('#folder-dialog').close();
  folderState.onSelect?.(path);
}

function row(entry) {
  const folderIcon = h('span', { class: `folder-icon${entry.isRepo ? ' repo' : ''}`, 'aria-hidden': 'true' });
  if (!entry.isRepo) {
    return h('li', {}, h('button', { type: 'button', class: 'folder-open', title: entry.path, onclick: () => openFolder(entry.path) }, folderIcon, h('span', { class: 'name' }, entry.name)));
  }
  return h('li', {},
    h('button', { type: 'button', class: 'folder-open', title: `Select ${entry.path}`, onclick: () => select(entry.path) },
      folderIcon, h('span', { class: 'name' }, entry.name), h('span', { class: 'badge-git' }, 'git')),
    h('button', { type: 'button', class: 'btn small ghost', title: 'Open this folder', onclick: () => openFolder(entry.path) }, 'Open'),
    h('button', { type: 'button', class: 'btn small', onclick: () => select(entry.path) }, 'Select'));
}

function renderList() {
  const needle = $('#folder-filter').value.trim().toLowerCase();
  const { listing, scan } = folderState;
  const items = scan ? scan.repos : listing?.entries ?? [];
  const visible = items.filter((e) => !needle || e.name.toLowerCase().includes(needle));
  if (visible.length === 0) {
    message(needle ? 'No folders match the filter.' : scan ? 'No git repositories found here.' : 'This folder has no subfolders.');
    return;
  }
  fill($('#folder-list'), ...visible.map(row));
}

function renderCrumbs(path) {
  const parts = path.split('/').filter(Boolean);
  const crumbs = [h('button', { type: 'button', onclick: () => openFolder('/'), 'aria-current': parts.length === 0 ? 'location' : null }, '/')];
  parts.forEach((part, i) => {
    const target = `/${parts.slice(0, i + 1).join('/')}`;
    const last = i === parts.length - 1;
    if (i > 0) crumbs.push(h('span', { class: 'sep' }, '/'));
    crumbs.push(h('button', { type: 'button', 'aria-current': last ? 'location' : null, onclick: last ? null : () => openFolder(target) }, part));
  });
  const nav = $('#folder-crumbs');
  fill(nav, ...crumbs);
  nav.scrollLeft = nav.scrollWidth;
}

function renderFooter() {
  const { listing } = folderState;
  const button = $('#folder-select');
  if (listing?.repoRoot) {
    const inside = listing.repoRoot !== listing.path;
    $('#folder-current').textContent = inside ? `Inside the git repository ${listing.repoRoot}` : `Git repository: ${listing.path}`;
    button.textContent = inside ? 'Use this repository' : 'Use this folder';
    button.disabled = false;
  } else {
    $('#folder-current').textContent = 'Not a git repository. Choose a folder marked git.';
    button.textContent = 'Use this folder';
    button.disabled = true;
  }
}

async function openFolder(path) {
  folderState.scan = null;
  $('#folder-note').textContent = '';
  message('Loading...');
  try {
    const params = new URLSearchParams({ path, ...($('#folder-hidden').checked ? { hidden: '1' } : {}) });
    const listing = await api(`/api/folders?${params}`);
    folderState.listing = listing;
    rememberFolder(listing.path);
    $('#folder-filter').value = '';
    renderCrumbs(listing.path);
    $('#folder-up').disabled = !listing.parent;
    const repos = listing.entries.filter((e) => e.isRepo).length;
    $('#folder-note').textContent = `${plural(listing.entries.length, 'folder')}${repos ? `, ${plural(repos, 'git repository', 'git repositories')}` : ''}${listing.truncated ? ' (showing the first 1000)' : ''}`;
    renderList();
    renderFooter();
  } catch (error) {
    message(error.message);
  }
}

async function scanForRepos() {
  const { listing } = folderState;
  if (!listing) return;
  const button = $('#folder-scan');
  button.disabled = true;
  message('Looking for git repositories...');
  try {
    const scan = await api(`/api/folders/repos?${new URLSearchParams({ path: listing.path })}`);
    folderState.scan = scan;
    $('#folder-filter').value = '';
    fill($('#folder-note'), 
      `${plural(scan.repos.length, 'git repository', 'git repositories')} found up to 3 levels down${scan.complete ? '' : ' (search stopped early)'}. `,
      h('button', { type: 'button', class: 'link', onclick: () => openFolder(listing.path) }, 'Back to folders'),
    );
    renderList();
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
}

async function pickWithFinder() {
  try {
    const result = await api('/api/folders/pick', { method: 'POST', body: {} });
    if (result.path) select(result.path);
  } catch (error) {
    $('#folder-note').textContent = error.message;
  }
}

function renderShortcuts() {
  const shortcuts = [h('button', { type: 'button', class: 'chip', onclick: () => openFolder('~') }, 'Home')];
  if (state.status?.launchRepo) {
    shortcuts.push(h('button', { type: 'button', class: 'chip', title: state.status.launchRepo, onclick: () => openFolder(parentDir(state.status.launchRepo)) }, 'Launch folder'));
  }
  for (const r of state.recentRepos.slice(0, 5)) {
    shortcuts.push(h('button', { type: 'button', class: 'chip', title: `Select ${r.repoPath}`, onclick: () => select(r.repoPath) }, r.repo));
  }
  if (state.status?.nativeFolderPicker) {
    shortcuts.push(h('button', { type: 'button', class: 'chip', title: 'Open the macOS folder chooser', onclick: pickWithFinder }, 'Choose in Finder…'));
  }
  fill($('#folder-shortcuts'), ...shortcuts);
}

function wire() {
  if (wired) return;
  wired = true;
  $('#folder-up').addEventListener('click', () => folderState.listing?.parent && openFolder(folderState.listing.parent));
  $('#folder-filter').addEventListener('input', renderList);
  $('#folder-hidden').addEventListener('change', () => folderState.listing && openFolder(folderState.listing.path));
  $('#folder-scan').addEventListener('click', scanForRepos);
  $('#folder-select').addEventListener('click', () => folderState.listing?.repoRoot && select(folderState.listing.repoRoot));
}

/** Open the folder browser next to `current` (a repo path) and call onSelect(path) on choice. */
export function openFolderDialog({ current, onSelect }) {
  wire();
  folderState.onSelect = onSelect;
  const start = current?.startsWith('/') ? parentDir(current) : lastFolder() ?? (state.status?.launchRepo ? parentDir(state.status.launchRepo) : '~');
  renderShortcuts();
  $('#folder-dialog').showModal();
  openFolder(start);
}
