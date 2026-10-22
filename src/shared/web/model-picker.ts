// The "Sonnet 5.5 · High" control: a chip that opens a menu of models and efforts, the same as Claude Translate's (the markup
// and keys are the same, so base.css styles both). The choice is kept in localStorage under the page's own key.
// Served at /shared/web/model-picker.ts with its types stripped.
import type { Effort, EffortOption, ModelOption } from '../api-types.ts';
import { createIcon, readStored, writeStored } from './ui.ts';

export interface PickerOptions {
  models: ModelOption[];
  efforts: EffortOption[];
  defaultModelId: string;
  defaultEffort: Effort;
}

export interface PickerSettings {
  modelId: string;
  effort: Effort;
}

export interface ModelPicker {
  // The chip, to place in a header; the menu is already in the page.
  chip: HTMLButtonElement;
  settings(): PickerSettings;
  // "Sonnet 5.5 · High", or "Sonnet 5.5" for an effort that is not known; the id itself for a model no longer offered.
  labelOf(model_id: string, effort: string | null): string;
}

const CHECK_ICON = '<svg class="menu-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// The keys an arrow, Home or End moves a menu's focus to; undefined for any other key.
function arrowTargetOf(key: string, focused_index: number, row_count: number): number | undefined {
  const targets: Record<string, number> = { ArrowDown: focused_index + 1, ArrowUp: focused_index - 1, Home: 0, End: row_count - 1 };
  return targets[key];
}

// Signal bars, one per effort offered, the chosen one and those below it filled.
function effortGlyphMarkup(efforts: EffortOption[], effort: string): string {
  const filled_count = efforts.findIndex((option) => option.effort === effort) + 1;
  const bar_step = 13 / efforts.length;
  return efforts.map((_, index) => {
    const bar_height = 4 + (8 * index) / Math.max(1, efforts.length - 1);
    return `<rect x="${index * bar_step}" y="${12 - bar_height}" width="3" height="${bar_height}" rx="1" class="${index < filled_count ? 'is-filled' : ''}"/>`;
  }).join('');
}

// storage_key: where the choice is remembered. The menu is appended to `host` (any element of the page).
export function createModelPicker({ models, efforts, defaultModelId: default_model_id, defaultEffort: default_effort }: PickerOptions, storage_key: string, host: HTMLElement): ModelPicker {
  const modelLabel = (model_id: string): string => models.find((option) => option.modelId === model_id)?.label ?? model_id;
  const effortLabel = (effort: string | null): string | undefined => efforts.find((option) => option.effort === effort)?.label;
  const labelOf = (model_id: string, effort: string | null): string => [modelLabel(model_id), effortLabel(effort)].filter((part) => part !== undefined).join(' · ');

  // A stored model or effort the server no longer offers falls back to its default, so a removed one never sticks.
  function readSettings(): PickerSettings {
    let stored: Partial<PickerSettings> | null = null;
    try { stored = JSON.parse(readStored(storage_key) ?? 'null') as Partial<PickerSettings> | null; } catch { /* Unreadable: the defaults apply. */ }
    return {
      modelId: models.some((option) => option.modelId === stored?.modelId) ? stored!.modelId! : default_model_id,
      effort: efforts.some((option) => option.effort === stored?.effort) ? stored!.effort! : default_effort,
    };
  }
  let current = readSettings();

  const chip = document.createElement('button');
  chip.className = 'settings-chip model-chip';
  chip.type = 'button';
  chip.setAttribute('popovertarget', 'model-menu');
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-keyshortcuts', 'Meta+/');
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('class', 'effort-glyph');
  glyph.setAttribute('viewBox', '0 0 13 12');
  glyph.setAttribute('aria-hidden', 'true');
  const label_full = document.createElement('span');
  label_full.className = 'chip-label-full';
  const label_short = document.createElement('span');
  label_short.className = 'chip-label-short';
  const chevron = createIcon('chevron', 'chip-chevron');
  chip.append(glyph, label_full, label_short, chevron);

  const menu = document.createElement('div');
  menu.className = 'settings-menu model-menu';
  menu.id = 'model-menu';
  menu.setAttribute('popover', '');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Model and effort');
  // Labels and descriptions come from the server's own constants, so they are trusted markup.
  menu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Model<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Model">${models.map((option) => `
      <button class="menu-option" type="button" role="menuitemradio" data-model-id="${option.modelId}" tabindex="-1">
        <span><span class="menu-option-name">${option.label}${option.modelId === default_model_id ? '<span class="menu-option-default">Default</span>' : ''}</span>
        <span class="menu-option-description">${option.description}</span></span>${CHECK_ICON}
      </button>`).join('')}</div>
    <div class="model-menu-separator" role="separator"></div>
    <div class="menu-label" aria-hidden="true">Effort<span class="menu-keys">← →</span></div>
    <div class="effort-control" role="group" aria-label="Effort">
      <div class="effort-segments">${efforts.map((option) => `<button class="effort-option" type="button" role="menuitemradio" data-effort="${option.effort}" tabindex="-1">${option.label}</button>`).join('')}</div>
      <p class="effort-description"></p>
    </div>`;
  host.append(menu);

  const rows = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('.menu-option')];
  const segments = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('.effort-option')];
  // The menu's stops in arrow order: every model row, then the checked effort segment as one stop.
  const stops = (): HTMLElement[] => [...rows(), menu.querySelector<HTMLElement>('.effort-option[aria-checked="true"]')!];

  function render(): void {
    label_full.textContent = labelOf(current.modelId, current.effort);
    label_short.textContent = `${models.find((option) => option.modelId === current.modelId)?.shortLabel ?? current.modelId} · ${effortLabel(current.effort) ?? ''}`;
    glyph.innerHTML = effortGlyphMarkup(efforts, current.effort);
    chip.title = `${label_full.textContent} (⌘/)`;
    chip.setAttribute('aria-label', `Model and effort: ${label_full.textContent}`);
    for (const row of rows()) row.setAttribute('aria-checked', String(row.dataset.modelId === current.modelId));
    for (const segment of segments()) segment.setAttribute('aria-checked', String(segment.dataset.effort === current.effort));
    menu.querySelector('.effort-description')!.textContent = efforts.find((option) => option.effort === current.effort)?.description ?? '';
  }

  function change(next: PickerSettings): void {
    current = next;
    writeStored(storage_key, JSON.stringify(next));
    render();
  }

  function stepEffort(step: number): void {
    const ids = efforts.map((option) => option.effort);
    const was_on_effort = document.activeElement?.classList.contains('effort-option');
    change({ ...current, effort: ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(current.effort) + step))] });
    if (was_on_effort) menu.querySelector<HTMLElement>('.effort-option[aria-checked="true"]')!.focus();
  }

  // An open menu focuses its checked row. Esc and a click outside close the popover natively; focus returns to the
  // chip only if it was in the menu.
  menu.addEventListener('toggle', (event) => {
    const is_open = (event as ToggleEvent).newState === 'open';
    chip.setAttribute('aria-expanded', String(is_open));
    if (is_open) menu.querySelector<HTMLElement>('.menu-option[aria-checked="true"]')!.focus();
  });
  menu.addEventListener('beforetoggle', (event) => {
    if ((event as ToggleEvent).newState === 'closed' && menu.contains(document.activeElement)) queueMicrotask(() => chip.focus());
  });
  menu.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.menu-option');
    const segment = target?.closest<HTMLElement>('.effort-option');
    if (row) {
      change({ ...current, modelId: row.dataset.modelId! });
      menu.hidePopover();
    } else if (segment) {
      // An effort is a setting, not a command: the menu stays open.
      change({ ...current, effort: segment.dataset.effort as Effort });
    }
  });
  menu.addEventListener('keydown', (event) => {
    const all = stops();
    const focused_index = all.findIndex((stop) => stop === document.activeElement);
    const target_index = arrowTargetOf(event.key, focused_index, all.length);
    if (target_index !== undefined) {
      event.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, target_index))].focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      stepEffort(event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const row = document.activeElement?.closest<HTMLElement>('.menu-option');
      if (row) change({ ...current, modelId: row.dataset.modelId! });
      menu.hidePopover();
    } else if (event.key === 'Tab') {
      // The menu lives at the end of the page; Tab goes on from its chip instead.
      event.preventDefault();
      chip.focus();
      menu.hidePopover();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === '/' && chip.isConnected) {
      event.preventDefault();
      menu.togglePopover();
    }
  });

  render();
  return { chip, settings: () => current, labelOf };
}
