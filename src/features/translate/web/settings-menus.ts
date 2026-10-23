// The two settings menus under the text box: Mode (the source format), and Model with Effort. They hold what the next
// translation runs with, remember it in localStorage, and show the latest quota warning.
import type { Effort, EffortOption } from '../../../shared/api-types.ts';
import type { QuotaWarning, SourceFormat, TranslationOptions } from '../api-types.ts';
import { fetchJson } from '../../../shared/web/fetch-json.ts';
import { readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';

// What the next translation runs with.
interface TranslationSettings {
  modelId: string;
  effort: Effort;
  sourceFormat: SourceFormat;
}

const TRANSLATION_SETTINGS_STORAGE_KEY = 'translation_settings';
const MENU_CHECK_ICON = '<svg class="menu-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const QUOTA_WINDOW_LABELS: Record<string, string> = { seven_day: 'Weekly', five_hour: '5-hour' };

const modeButton = requiredElement('#mode-button', HTMLButtonElement);
const modeButtonLabel = requiredElement('#mode-button-label', HTMLSpanElement);
const modeMenu = requiredElement('#mode-menu', HTMLDivElement);
const modelPickerButton = requiredElement('#model-picker-button', HTMLButtonElement);
const modelPickerLabelFull = requiredElement('#model-picker-label-full', HTMLSpanElement);
const modelPickerLabelShort = requiredElement('#model-picker-label-short', HTMLSpanElement);
const modelPickerEffortGlyph = requiredElement('#model-picker-effort-glyph', SVGSVGElement);
const modelMenu = requiredElement('#model-menu', HTMLDivElement);
// Tab from the model menu goes on to these.
const translateButton = requiredElement('#translate-button', HTMLButtonElement);
const swapButton = requiredElement('#swap-button', HTMLButtonElement);

// GET /translation-options: the models, efforts and modes the server accepts, and its latest quota warning.
// Written only by loadTranslationOptions.
let translationOptions: TranslationOptions | null = null;
// { modelId, effort, sourceFormat } the next translation runs with. Written only by setTranslationSettings.
let loadedSettings: TranslationSettings | null = null;

// null until the options have loaded.
export function translationSettings(): TranslationSettings | null {
  return loadedSettings;
}

export function closeSettingsMenus(): void {
  modeMenu.hidePopover();
  modelMenu.hidePopover();
}

// ⌘/ opens the model menu, or closes it.
export function toggleModelMenu(): void {
  modeMenu.hidePopover();
  modelMenu.togglePopover();
}

// The menu that is open, if one is.
export function openSettingsMenu(): HTMLElement | undefined {
  return [modeMenu, modelMenu].find((menu) => menu.matches(':popover-open'));
}

// The options once loaded; the menus and pickers are built only after that.
function loadedOptions(): TranslationOptions {
  if (translationOptions === null) throw new Error('The translation options have not loaded yet.');
  return translationOptions;
}

function currentSettings(): TranslationSettings {
  if (loadedSettings === null) throw new Error('The translation settings have not loaded yet.');
  return loadedSettings;
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

// The row index an arrow, Home or End key moves to in a list of rowCount rows; undefined for any other key.
export function arrowTargetOf(key: string, focusedIndex: number, rowCount: number): number | undefined {
  const targets: Record<string, number> = {
    ArrowDown: focusedIndex + 1,
    ArrowUp: focusedIndex - 1,
    Home: 0,
    End: rowCount - 1,
  };
  return targets[key];
}

// Called once at load: the options do not change while the page is open.
export async function loadTranslationOptions(): Promise<void> {
  translationOptions = await fetchJson<TranslationOptions>('/translation-options');
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

function renderQuotaWarning(quotaWarning: QuotaWarning | null): void {
  const quotaLine = requiredElement('.model-menu-quota', HTMLDivElement, modelMenu);
  quotaLine.hidden = quotaWarning === null;
  const quotaText = requiredElement('.model-menu-quota-text', HTMLSpanElement, quotaLine);
  quotaText.innerHTML = quotaWarning === null ? '' : quotaWarningHtml(quotaWarning);
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
  const hasModel = options.models.some((option) => option.modelId === stored?.modelId);
  const hasEffort = options.efforts.some((option) => option.effort === stored?.effort);
  const hasMode = options.sourceFormats.some((option) => option.sourceFormat === stored?.sourceFormat);
  return {
    modelId: hasModel && stored?.modelId ? stored.modelId : options.defaultModelId,
    effort: hasEffort && stored?.effort ? stored.effort : options.defaultEffort,
    sourceFormat: hasMode && stored?.sourceFormat ? stored.sourceFormat : options.defaultSourceFormat,
  };
}

function setTranslationSettings(nextSettings: TranslationSettings): void {
  loadedSettings = nextSettings;
  writeStored(TRANSLATION_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
  renderModePicker();
  renderModelPicker();
}

// The id itself for a model no longer offered (a history entry can name one), or while the options failed to load:
// history and run info must still render then.
export function modelLabelOf(modelId: string): string {
  const modelOption = translationOptions?.models.find((option) => option.modelId === modelId);
  return modelOption?.label ?? modelId;
}

function effortOptionOf(effort: string): EffortOption | undefined {
  return translationOptions?.efforts.find((option) => option.effort === effort);
}

function sourceFormatLabelOf(mode: string): string {
  const modeOption = translationOptions?.sourceFormats.find((option) => option.sourceFormat === mode);
  return modeOption?.label ?? mode;
}

// "Sonnet 5.5 · Low": the one wording of a model and effort, used by the trigger, history run info and tooltips.
export function choiceLabelOf({ modelId, effort }: { modelId: string; effort: string }): string {
  const effortLabel = effortOptionOf(effort)?.label ?? effort;
  return `${modelLabelOf(modelId)} · ${effortLabel}`;
}

// "Markdown · " for a history entry's source format; '' for the default one, which most entries use, or none.
export function sourceFormatNoteOf(mode: SourceFormat | undefined): string {
  if (translationOptions === null || mode === undefined) return '';
  if (mode === translationOptions.defaultSourceFormat) return '';
  return `${sourceFormatLabelOf(mode)} · `;
}

// "Weekly limit 94% used · resets Mon 06:00"
function quotaWarningHtml({ rateLimitType, utilization, resetsAt }: QuotaWarning): string {
  const windowLabel = QUOTA_WINDOW_LABELS[rateLimitType ?? ''] ?? 'Usage';
  let percentText = 'nearly used';
  if (typeof utilization === 'number') percentText = `<strong>${Math.round(utilization * 100)}%</strong> used`;
  let resetsText = '';
  if (typeof resetsAt === 'number') {
    const resetTime = new Date(resetsAt * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    resetsText = ` · resets ${resetTime}`;
  }
  return `${windowLabel} limit ${percentText}${resetsText}`;
}

// Labels and descriptions come from the server's own constants, so they are trusted markup.
function menuOptionMarkup({ dataAttribute, value, label, description, isDefault }: {
  dataAttribute: string; value: string; label: string; description: string; isDefault: boolean;
}): string {
  const defaultBadge = isDefault ? '<span class="menu-option-default">Default</span>' : '';
  return `
    <button class="menu-option" role="menuitemradio" ${dataAttribute}="${value}" tabindex="-1">
      <span><span class="menu-option-name">${label}${defaultBadge}</span>
      <span class="menu-option-description">${description}</span></span>${MENU_CHECK_ICON}
    </button>`;
}

function renderModeMenu(): void {
  const options = loadedOptions();
  const modeRows = options.sourceFormats.map((option) => menuOptionMarkup({
    dataAttribute: 'data-mode',
    value: option.sourceFormat,
    label: option.label,
    description: option.description,
    isDefault: option.sourceFormat === options.defaultSourceFormat,
  }));
  modeMenu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Mode<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Mode">${modeRows.join('')}</div>`;
}

function renderModelMenu(): void {
  const options = loadedOptions();
  const modelRows = options.models.map((option) => menuOptionMarkup({
    dataAttribute: 'data-model-id',
    value: option.modelId,
    label: option.label,
    description: option.description,
    isDefault: option.modelId === options.defaultModelId,
  }));
  const effortSegments = options.efforts.map((option) => {
    return `<button class="effort-option" role="menuitemradio" data-effort="${option.effort}" tabindex="-1">${option.label}</button>`;
  });
  modelMenu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Model<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Model">${modelRows.join('')}</div>
    <div class="model-menu-separator" role="separator"></div>
    <div class="menu-label" aria-hidden="true">Effort<span class="menu-keys">← →</span></div>
    <div class="effort-control" role="group" aria-label="Effort">
      <div class="effort-segments">${effortSegments.join('')}</div>
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
  const filledCount = efforts.findIndex((offeredEffort) => offeredEffort === effort) + 1;
  const barStep = 13 / efforts.length;
  const bars = efforts.map((_, index) => {
    // The bars grow from 4 to 12 high, left to right.
    const barHeight = 4 + (8 * index) / Math.max(1, efforts.length - 1);
    const fillClass = index < filledCount ? 'is-filled' : '';
    return `<rect x="${index * barStep}" y="${12 - barHeight}" width="3" height="${barHeight}" rx="1" class="${fillClass}"/>`;
  });
  return bars.join('');
}

function renderModePicker(): void {
  const { sourceFormat: mode } = currentSettings();
  const modeLabel = sourceFormatLabelOf(mode);
  modeButtonLabel.textContent = modeLabel;
  modeButton.title = `Mode: ${modeLabel}`;
  modeButton.setAttribute('aria-label', `Mode: ${modeLabel}`);
  for (const row of modeMenu.querySelectorAll<HTMLElement>('.menu-option')) {
    row.setAttribute('aria-checked', String(row.dataset.mode === mode));
  }
}

function renderModelPicker(): void {
  const settings = currentSettings();
  const modelOption = loadedOptions().models.find((option) => option.modelId === settings.modelId);
  const effortOption = effortOptionOf(settings.effort);
  if (modelOption === undefined || effortOption === undefined) throw new Error(`Unknown setting ${choiceLabelOf(settings)}`);
  const choiceLabel = choiceLabelOf(settings);
  modelPickerLabelFull.textContent = choiceLabel;
  modelPickerLabelShort.textContent = `${modelOption.shortLabel} · ${effortOption.label}`;
  modelPickerEffortGlyph.innerHTML = effortGlyphMarkup(settings.effort);
  modelPickerButton.title = `${choiceLabel} (⌘/)`;
  modelPickerButton.setAttribute('aria-label', `Model and effort: ${choiceLabel}`);
  for (const row of modelMenu.querySelectorAll<HTMLElement>('.menu-option')) {
    row.setAttribute('aria-checked', String(row.dataset.modelId === settings.modelId));
  }
  for (const segment of modelMenu.querySelectorAll<HTMLElement>('.effort-option')) {
    segment.setAttribute('aria-checked', String(segment.dataset.effort === settings.effort));
  }
  requiredElement('#effort-description', HTMLParagraphElement, modelMenu).textContent = effortOption.description;
}

// The model menu's stops in arrow order: every model row, then the checked effort segment as one stop.
function modelMenuStops(): HTMLElement[] {
  const modelRows = [...modelMenu.querySelectorAll<HTMLElement>('.menu-option')];
  const checkedEffort = requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, modelMenu);
  return [...modelRows, checkedEffort];
}

function stepEffort(step: number): void {
  const efforts = loadedOptions().efforts.map((option) => option.effort);
  const currentIndex = efforts.indexOf(currentSettings().effort);
  const nextIndex = Math.max(0, Math.min(efforts.length - 1, currentIndex + step));
  const wasOnEffort = document.activeElement?.classList.contains('effort-option');
  setTranslationSettings({ ...currentSettings(), effort: efforts[nextIndex] });
  if (wasOnEffort) requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, modelMenu).focus();
}

// Moves focus to the row an arrow, Home or End key points at; true when the key was one of those.
function moveFocusByKey(key: string, stops: HTMLElement[]): boolean {
  const focusedIndex = stops.findIndex((stop) => stop === document.activeElement);
  const targetIndex = arrowTargetOf(key, focusedIndex, stops.length);
  if (targetIndex === undefined) return false;
  stops[Math.max(0, Math.min(stops.length - 1, targetIndex))].focus();
  return true;
}

// An open menu focuses its checked row. Esc and a click outside close the popover natively; focus returns to the
// trigger only if it was in the menu.
for (const [menu, trigger] of [[modeMenu, modeButton], [modelMenu, modelPickerButton]]) {
  menu.addEventListener('toggle', (event) => {
    const isOpen = (event as ToggleEvent).newState === 'open';
    trigger.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) requiredElement('.menu-option[aria-checked="true"]', HTMLButtonElement, menu).focus();
  });
  menu.addEventListener('beforetoggle', (event) => {
    const isClosing = (event as ToggleEvent).newState === 'closed';
    if (isClosing && menu.contains(document.activeElement)) queueMicrotask(() => trigger.focus());
  });
}

modeMenu.addEventListener('click', (event) => {
  const modeRow = eventElement(event)?.closest<HTMLElement>('.menu-option');
  if (!modeRow) return;
  setTranslationSettings({ ...currentSettings(), sourceFormat: sourceFormatOfRow(modeRow) });
  modeMenu.hidePopover();
});

modeMenu.addEventListener('keydown', (event) => {
  const rows = [...modeMenu.querySelectorAll<HTMLElement>('.menu-option')];
  if (moveFocusByKey(event.key, rows)) {
    event.preventDefault();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const modeRow = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (modeRow) setTranslationSettings({ ...currentSettings(), sourceFormat: sourceFormatOfRow(modeRow) });
    modeMenu.hidePopover();
  } else if (event.key === 'Tab') {
    // The menu lives at the end of the DOM; Tab goes on from its chip instead.
    event.preventDefault();
    (event.shiftKey ? modeButton : modelPickerButton).focus();
    modeMenu.hidePopover();
  }
});

modelMenu.addEventListener('click', (event) => {
  const modelRow = eventElement(event)?.closest<HTMLElement>('.menu-option');
  const effortSegment = eventElement(event)?.closest<HTMLElement>('.effort-option');
  if (modelRow) {
    setTranslationSettings({ ...currentSettings(), modelId: modelIdOfRow(modelRow) });
    modelMenu.hidePopover();
  } else if (effortSegment) {
    // An effort is a setting, not a command: the menu stays open.
    setTranslationSettings({ ...currentSettings(), effort: effortOfSegment(effortSegment) });
  }
});

modelMenu.addEventListener('keydown', (event) => {
  if (moveFocusByKey(event.key, modelMenuStops())) {
    event.preventDefault();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepEffort(event.key === 'ArrowRight' ? 1 : -1);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const modelRow = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (modelRow) setTranslationSettings({ ...currentSettings(), modelId: modelIdOfRow(modelRow) });
    modelMenu.hidePopover();
  } else if (event.key === 'Tab') {
    // Focus leaves before the menu closes, so the close does not send it back to the trigger.
    event.preventDefault();
    // A disabled Translate cannot take focus; the swap button is the next stop after it.
    const nextStop = translateButton.disabled ? swapButton : translateButton;
    (event.shiftKey ? modelPickerButton : nextStop).focus();
    modelMenu.hidePopover();
  }
});
