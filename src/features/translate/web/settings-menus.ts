// The two settings menus under the text box: Mode (the source format), and Model with Effort. They hold what the next
// translation runs with, remember it in localStorage, and show the latest quota warning.
import type { Effort, EffortOption } from '../../../shared/api-types.ts';
import type { QuotaWarning, SourceFormat, TranslationOptions } from '../api-types.ts';
import { fetchJson } from '../../../shared/web/fetch-json.ts';
import { readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';

// What the next translation runs with.
export interface TranslationSettings {
  modelId: string;
  effort: Effort;
  sourceFormat: SourceFormat;
}

const TRANSLATION_SETTINGS_STORAGE_KEY = 'translation_settings';
const MENU_CHECK_ICON = '<svg class="menu-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const QUOTA_WINDOW_LABELS: Record<string, string> = { seven_day: 'Weekly', five_hour: '5-hour' };

const mode_button = requiredElement('#mode-button', HTMLButtonElement);
const mode_button_label = requiredElement('#mode-button-label', HTMLSpanElement);
const mode_menu = requiredElement('#mode-menu', HTMLDivElement);
const model_picker_button = requiredElement('#model-picker-button', HTMLButtonElement);
const model_picker_label_full = requiredElement('#model-picker-label-full', HTMLSpanElement);
const model_picker_label_short = requiredElement('#model-picker-label-short', HTMLSpanElement);
const model_picker_effort_glyph = requiredElement('#model-picker-effort-glyph', SVGSVGElement);
const model_menu = requiredElement('#model-menu', HTMLDivElement);
// Tab from the model menu goes on to these.
const translate_button = requiredElement('#translate-button', HTMLButtonElement);
const swap_button = requiredElement('#swap-button', HTMLButtonElement);

// GET /translation-options: the models, efforts and modes the server accepts, and its latest quota warning.
// Written only by loadTranslationOptions.
let translation_options: TranslationOptions | null = null;
// { modelId, effort, sourceFormat } the next translation runs with. Written only by setTranslationSettings.
let translation_settings: TranslationSettings | null = null;

// null until the options have loaded.
export function translationSettings(): TranslationSettings | null {
  return translation_settings;
}

export function closeSettingsMenus(): void {
  mode_menu.hidePopover();
  model_menu.hidePopover();
}

// ⌘/ opens the model menu, or closes it.
export function toggleModelMenu(): void {
  mode_menu.hidePopover();
  model_menu.togglePopover();
}

// The menu that is open, if one is.
export function openSettingsMenu(): HTMLElement | undefined {
  return [mode_menu, model_menu].find((menu) => menu.matches(':popover-open'));
}

// The options once loaded; the menus and pickers are built only after that.
function loadedOptions(): TranslationOptions {
  if (translation_options === null) throw new Error('The translation options have not loaded yet.');
  return translation_options;
}

function currentSettings(): TranslationSettings {
  if (translation_settings === null) throw new Error('The translation settings have not loaded yet.');
  return translation_settings;
}

// The element an event happened on, or null for a non-element target.
function eventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

// The value a menu row's data attribute names, checked against what the server offers.
function offeredValueOf<Value extends string>(offered: Value[], value: string | undefined): Value {
  const found = offered.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`The menu offers no ${value}`);
  return found;
}

function sourceFormatOfRow(row: HTMLElement): SourceFormat {
  return offeredValueOf(loadedOptions().sourceFormats.map((option) => option.sourceFormat), row.dataset.mode);
}

function modelIdOfRow(row: HTMLElement): string {
  return offeredValueOf(loadedOptions().models.map((option) => option.modelId), row.dataset.modelId);
}

function effortOfSegment(segment: HTMLElement): Effort {
  return offeredValueOf(loadedOptions().efforts.map((option) => option.effort), segment.dataset.effort);
}

// The row index an arrow, Home or End key moves to in a list of row_count rows; undefined for any other key.
export function arrowTargetOf(key: string, focused_index: number, row_count: number): number | undefined {
  const targets: Record<string, number> = {
    ArrowDown: focused_index + 1,
    ArrowUp: focused_index - 1,
    Home: 0,
    End: row_count - 1,
  };
  return targets[key];
}

// Called once at load: the options do not change while the page is open.
export async function loadTranslationOptions(): Promise<void> {
  translation_options = await fetchJson<TranslationOptions>('/translation-options');
  renderModeMenu();
  renderModelMenu();
  renderQuotaWarning(loadedOptions().quotaWarning);
  setTranslationSettings(readTranslationSettings());
}

// After every translation, whose reply carries the current quota. Only the quota line changes, so focus inside an
// open menu is kept; if the fetch fails the line keeps its last state.
export function refreshQuotaWarning(): void {
  fetchJson<TranslationOptions>('/translation-options')
    .then((options) => renderQuotaWarning(options.quotaWarning))
    .catch(() => {});
}

function renderQuotaWarning(quota_warning: QuotaWarning | null): void {
  const quota_line = requiredElement('.model-menu-quota', HTMLDivElement, model_menu);
  quota_line.hidden = quota_warning === null;
  const quota_text = requiredElement('.model-menu-quota-text', HTMLSpanElement, quota_line);
  quota_text.innerHTML = quota_warning === null ? '' : quotaWarningHtml(quota_warning);
}

// A stored model, effort or mode the server no longer offers falls back to its default, so a removed one never sticks.
function readTranslationSettings(): TranslationSettings {
  const options = loadedOptions();
  let stored: Partial<TranslationSettings> | null = null;
  try {
    stored = JSON.parse(readStored(TRANSLATION_SETTINGS_STORAGE_KEY) ?? 'null') as Partial<TranslationSettings> | null;
  } catch {
    // Unreadable: the defaults apply.
  }
  const has_model = options.models.some((option) => option.modelId === stored?.modelId);
  const has_effort = options.efforts.some((option) => option.effort === stored?.effort);
  const has_mode = options.sourceFormats.some((option) => option.sourceFormat === stored?.sourceFormat);
  return {
    modelId: has_model && stored?.modelId ? stored.modelId : options.defaultModelId,
    effort: has_effort && stored?.effort ? stored.effort : options.defaultEffort,
    sourceFormat: has_mode && stored?.sourceFormat ? stored.sourceFormat : options.defaultSourceFormat,
  };
}

function setTranslationSettings(next_settings: TranslationSettings): void {
  translation_settings = next_settings;
  writeStored(TRANSLATION_SETTINGS_STORAGE_KEY, JSON.stringify(next_settings));
  renderModePicker();
  renderModelPicker();
}

// The id itself for a model no longer offered (a history entry can name one), or while the options failed to load:
// history and run info must still render then.
export function modelLabelOf(model_id: string): string {
  const model_option = translation_options?.models.find((option) => option.modelId === model_id);
  return model_option?.label ?? model_id;
}

function effortOptionOf(effort: string): EffortOption | undefined {
  return translation_options?.efforts.find((option) => option.effort === effort);
}

function sourceFormatLabelOf(mode: string): string {
  const mode_option = translation_options?.sourceFormats.find((option) => option.sourceFormat === mode);
  return mode_option?.label ?? mode;
}

// "Sonnet 5.5 · Low": the one wording of a model and effort, used by the trigger, history run info and tooltips.
export function choiceLabelOf({ modelId: model_id, effort }: { modelId: string; effort: string }): string {
  const effort_label = effortOptionOf(effort)?.label ?? effort;
  return `${modelLabelOf(model_id)} · ${effort_label}`;
}

// "Markdown · " for a history entry's source format; '' for the default one, which most entries use, or none.
export function sourceFormatNoteOf(mode: SourceFormat | undefined): string {
  if (translation_options === null || mode === undefined) return '';
  if (mode === translation_options.defaultSourceFormat) return '';
  return `${sourceFormatLabelOf(mode)} · `;
}

// "Weekly limit 94% used · resets Mon 06:00"
function quotaWarningHtml({ rateLimitType: rate_limit_type, utilization, resetsAt: resets_at }: QuotaWarning): string {
  const window_label = QUOTA_WINDOW_LABELS[rate_limit_type ?? ''] ?? 'Usage';
  let percent_text = 'nearly used';
  if (typeof utilization === 'number') percent_text = `<strong>${Math.round(utilization * 100)}%</strong> used`;
  let resets_text = '';
  if (typeof resets_at === 'number') {
    const reset_time = new Date(resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    resets_text = ` · resets ${reset_time}`;
  }
  return `${window_label} limit ${percent_text}${resets_text}`;
}

// Labels and descriptions come from the server's own constants, so they are trusted markup.
function menuOptionMarkup({ data_attribute, value, label, description, is_default }: {
  data_attribute: string; value: string; label: string; description: string; is_default: boolean;
}): string {
  const default_badge = is_default ? '<span class="menu-option-default">Default</span>' : '';
  return `
    <button class="menu-option" role="menuitemradio" ${data_attribute}="${value}" tabindex="-1">
      <span><span class="menu-option-name">${label}${default_badge}</span>
      <span class="menu-option-description">${description}</span></span>${MENU_CHECK_ICON}
    </button>`;
}

function renderModeMenu(): void {
  const options = loadedOptions();
  const mode_rows = options.sourceFormats.map((option) => menuOptionMarkup({
    data_attribute: 'data-mode',
    value: option.sourceFormat,
    label: option.label,
    description: option.description,
    is_default: option.sourceFormat === options.defaultSourceFormat,
  }));
  mode_menu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Mode<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Mode">${mode_rows.join('')}</div>`;
}

function renderModelMenu(): void {
  const options = loadedOptions();
  const model_rows = options.models.map((option) => menuOptionMarkup({
    data_attribute: 'data-model-id',
    value: option.modelId,
    label: option.label,
    description: option.description,
    is_default: option.modelId === options.defaultModelId,
  }));
  const effort_segments = options.efforts.map((option) => {
    return `<button class="effort-option" role="menuitemradio" data-effort="${option.effort}" tabindex="-1">${option.label}</button>`;
  });
  model_menu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Model<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Model">${model_rows.join('')}</div>
    <div class="model-menu-separator" role="separator"></div>
    <div class="menu-label" aria-hidden="true">Effort<span class="menu-keys">← →</span></div>
    <div class="effort-control" role="group" aria-label="Effort">
      <div class="effort-segments">${effort_segments.join('')}</div>
      <p class="effort-description" id="effort-description"></p>
    </div>
    <div class="model-menu-quota" hidden>
      <span class="quota-mark" aria-hidden="true"></span>
      <span class="model-menu-quota-text"></span>
    </div>`;
}

// Signal bars, one per effort offered, the chosen one and those below it filled.
function effortGlyphMarkup(effort: string): string {
  const efforts = loadedOptions().efforts.map((option) => option.effort);
  const filled_count = efforts.findIndex((offered_effort) => offered_effort === effort) + 1;
  const bar_step = 13 / efforts.length;
  const bars = efforts.map((_, index) => {
    // The bars grow from 4 to 12 high, left to right.
    const bar_height = 4 + (8 * index) / Math.max(1, efforts.length - 1);
    const fill_class = index < filled_count ? 'is-filled' : '';
    return `<rect x="${index * bar_step}" y="${12 - bar_height}" width="3" height="${bar_height}" rx="1" class="${fill_class}"/>`;
  });
  return bars.join('');
}

function renderModePicker(): void {
  const { sourceFormat: mode } = currentSettings();
  const mode_label = sourceFormatLabelOf(mode);
  mode_button_label.textContent = mode_label;
  mode_button.title = `Mode: ${mode_label}`;
  mode_button.setAttribute('aria-label', `Mode: ${mode_label}`);
  for (const row of mode_menu.querySelectorAll<HTMLElement>('.menu-option')) {
    row.setAttribute('aria-checked', String(row.dataset.mode === mode));
  }
}

function renderModelPicker(): void {
  const settings = currentSettings();
  const model_option = loadedOptions().models.find((option) => option.modelId === settings.modelId);
  const effort_option = effortOptionOf(settings.effort);
  if (model_option === undefined || effort_option === undefined) throw new Error(`Unknown setting ${choiceLabelOf(settings)}`);
  const choice_label = choiceLabelOf(settings);
  model_picker_label_full.textContent = choice_label;
  model_picker_label_short.textContent = `${model_option.shortLabel} · ${effort_option.label}`;
  model_picker_effort_glyph.innerHTML = effortGlyphMarkup(settings.effort);
  model_picker_button.title = `${choice_label} (⌘/)`;
  model_picker_button.setAttribute('aria-label', `Model and effort: ${choice_label}`);
  for (const row of model_menu.querySelectorAll<HTMLElement>('.menu-option')) {
    row.setAttribute('aria-checked', String(row.dataset.modelId === settings.modelId));
  }
  for (const segment of model_menu.querySelectorAll<HTMLElement>('.effort-option')) {
    segment.setAttribute('aria-checked', String(segment.dataset.effort === settings.effort));
  }
  requiredElement('#effort-description', HTMLParagraphElement, model_menu).textContent = effort_option.description;
}

// The model menu's stops in arrow order: every model row, then the checked effort segment as one stop.
function modelMenuStops(): HTMLElement[] {
  const model_rows = [...model_menu.querySelectorAll<HTMLElement>('.menu-option')];
  const checked_effort = requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, model_menu);
  return [...model_rows, checked_effort];
}

function stepEffort(step: number): void {
  const efforts = loadedOptions().efforts.map((option) => option.effort);
  const current_index = efforts.indexOf(currentSettings().effort);
  const next_index = Math.max(0, Math.min(efforts.length - 1, current_index + step));
  const was_on_effort = document.activeElement?.classList.contains('effort-option');
  setTranslationSettings({ ...currentSettings(), effort: efforts[next_index] });
  if (was_on_effort) requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, model_menu).focus();
}

// Moves focus to the row an arrow, Home or End key points at; true when the key was one of those.
function moveFocusByKey(key: string, stops: HTMLElement[]): boolean {
  const focused_index = stops.findIndex((stop) => stop === document.activeElement);
  const target_index = arrowTargetOf(key, focused_index, stops.length);
  if (target_index === undefined) return false;
  stops[Math.max(0, Math.min(stops.length - 1, target_index))].focus();
  return true;
}

// An open menu focuses its checked row. Esc and a click outside close the popover natively; focus returns to the
// trigger only if it was in the menu.
for (const [menu, trigger] of [[mode_menu, mode_button], [model_menu, model_picker_button]]) {
  menu.addEventListener('toggle', (event) => {
    const is_open = (event as ToggleEvent).newState === 'open';
    trigger.setAttribute('aria-expanded', String(is_open));
    if (is_open) requiredElement('.menu-option[aria-checked="true"]', HTMLButtonElement, menu).focus();
  });
  menu.addEventListener('beforetoggle', (event) => {
    const is_closing = (event as ToggleEvent).newState === 'closed';
    if (is_closing && menu.contains(document.activeElement)) queueMicrotask(() => trigger.focus());
  });
}

mode_menu.addEventListener('click', (event) => {
  const mode_row = eventElement(event)?.closest<HTMLElement>('.menu-option');
  if (!mode_row) return;
  setTranslationSettings({ ...currentSettings(), sourceFormat: sourceFormatOfRow(mode_row) });
  mode_menu.hidePopover();
});

mode_menu.addEventListener('keydown', (event) => {
  const rows = [...mode_menu.querySelectorAll<HTMLElement>('.menu-option')];
  if (moveFocusByKey(event.key, rows)) {
    event.preventDefault();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const mode_row = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (mode_row) setTranslationSettings({ ...currentSettings(), sourceFormat: sourceFormatOfRow(mode_row) });
    mode_menu.hidePopover();
  } else if (event.key === 'Tab') {
    // The menu lives at the end of the DOM; Tab goes on from its chip instead.
    event.preventDefault();
    (event.shiftKey ? mode_button : model_picker_button).focus();
    mode_menu.hidePopover();
  }
});

model_menu.addEventListener('click', (event) => {
  const model_row = eventElement(event)?.closest<HTMLElement>('.menu-option');
  const effort_segment = eventElement(event)?.closest<HTMLElement>('.effort-option');
  if (model_row) {
    setTranslationSettings({ ...currentSettings(), modelId: modelIdOfRow(model_row) });
    model_menu.hidePopover();
  } else if (effort_segment) {
    // An effort is a setting, not a command: the menu stays open.
    setTranslationSettings({ ...currentSettings(), effort: effortOfSegment(effort_segment) });
  }
});

model_menu.addEventListener('keydown', (event) => {
  if (moveFocusByKey(event.key, modelMenuStops())) {
    event.preventDefault();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepEffort(event.key === 'ArrowRight' ? 1 : -1);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const model_row = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (model_row) setTranslationSettings({ ...currentSettings(), modelId: modelIdOfRow(model_row) });
    model_menu.hidePopover();
  } else if (event.key === 'Tab') {
    // Focus leaves before the menu closes, so the close does not send it back to the trigger.
    event.preventDefault();
    // A disabled Translate cannot take focus; the swap button is the next stop after it.
    const next_stop = translate_button.disabled ? swap_button : translate_button;
    (event.shiftKey ? model_picker_button : next_stop).focus();
    model_menu.hidePopover();
  }
});
