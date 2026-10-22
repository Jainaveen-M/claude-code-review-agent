// Settings dialog: model, effort, cost limit.
import { api } from './api.js';
import { $, fill, h, modelLabel } from './dom.js';
import { renderStatus, state } from './store.js';

const MODELS = ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let onSaved = null;

async function save(event) {
  if (event.submitter?.value !== 'save') return;
  event.preventDefault();
  try {
    state.status.config = await api('/api/config', {
      method: 'PUT',
      body: { model: $('#cfg-model').value, effort: $('#cfg-effort').value, maxBudgetUsd: $('#cfg-budget').value || null },
    });
    renderStatus();
    $('#settings-dialog').close();
    onSaved?.();
  } catch (error) {
    $('#settings-error').textContent = error.message;
  }
}

export function initSettings() {
  $('#settings-btn').addEventListener('click', () => openSettings());
  $('#settings-form').addEventListener('submit', save);
}

export function openSettings(afterSave) {
  onSaved = afterSave ?? null;
  const { config } = state.status;
  fill($('#cfg-model'), ...MODELS.map((m) => h('option', { value: m, selected: m === config.model }, modelLabel(m))));
  fill($('#cfg-effort'), ...EFFORTS.map((e) => h('option', { value: e, selected: e === config.effort }, e)));
  $('#cfg-budget').value = config.maxBudgetUsd ?? '';
  $('#settings-error').textContent = '';
  $('#settings-dialog').showModal();
}
