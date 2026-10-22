// Light / Dark / System switch in the top bar. The choice is remembered per browser.
import { $, fill, h, icon } from './dom.js';

const KEY = 'cra-theme';
const CHOICES = [
  { id: 'light', label: 'Light', iconName: 'sun' },
  { id: 'dark', label: 'Dark', iconName: 'moon' },
  { id: 'system', label: 'System', iconName: 'monitor' },
];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function savedChoice() {
  try {
    return localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
}

function apply(choice) {
  const dark = choice === 'dark' || (choice === 'system' && systemDark.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function render() {
  const choice = savedChoice();
  fill($('#theme-toggle'), CHOICES.map((c) => h('button', {
    type: 'button',
    'aria-pressed': c.id === choice ? 'true' : 'false',
    'aria-label': `${c.label} theme`,
    title: c.id === 'system' ? 'Match your system setting' : `${c.label} theme`,
    onclick: () => setTheme(c.id),
  }, icon(c.iconName, 15))));
}

export function setTheme(choice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: still switch for this page
  }
  apply(choice);
  render();
}

export function initTheme() {
  apply(savedChoice());
  render();
  systemDark.addEventListener('change', () => {
    if (savedChoice() === 'system') apply('system');
  });
}
