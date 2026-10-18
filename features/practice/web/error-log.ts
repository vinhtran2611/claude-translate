// The error log (#/errors): every mistake from graded attempts, which kinds come up most, and how often per week.
// One category filter at the top drives all three parts. Both charts are a single series in the accent colour, so
// they need no legend; text stays in the text colours, and every bar has a tooltip and its value in text nearby.
import { createElement } from '../../../shared/web/ui.ts';
import type { ErrorLog, ErrorLogEntry } from '../api.ts';
import { categoryLabelOf, type ErrorCategory } from '../categories.ts';

const WEEK_COUNT = 12;
const RATE_WINDOW_WEEKS = 4;
// Arbitrary: enough to scroll back through a few weeks without drawing thousands of cards at once.
const MISTAKES_PAGE_SIZE = 50;

export type CategoryFilter = ErrorCategory | 'all';

interface Week {
  start: Date;
  error_count: number;
  word_count: number;
}

// Monday 00:00 local time of the week date falls in.
function weekStartOf(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// The smallest 1, 2 or 5 × 10^n at or above value: a clean top for the axis.
function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((step) => step * magnitude >= value) ?? 10) * magnitude;
}

// Errors per 100 words; null when nothing was written, so an empty week is not drawn as zero.
function rateOf(error_count: number, word_count: number): number | null {
  return word_count === 0 ? null : (error_count / word_count) * 100;
}

function formatRate(rate: number | null): string {
  return rate === null ? '–' : rate.toFixed(1);
}

// The last WEEK_COUNT weeks, oldest first, ending with this week.
function weeksOf(log: ErrorLog, mistakes: ErrorLogEntry[], now: Date): Week[] {
  const this_week = weekStartOf(now);
  const weeks: Week[] = Array.from({ length: WEEK_COUNT }, (_, index) => {
    const start = new Date(this_week);
    start.setDate(start.getDate() - (WEEK_COUNT - 1 - index) * 7);
    return { start, error_count: 0, word_count: 0 };
  });
  const indexOf = (timestamp: string): number => {
    const start = weekStartOf(new Date(timestamp));
    return weeks.findIndex((week) => week.start.getTime() === start.getTime());
  };
  for (const attempt of log.graded_attempts) {
    const index = indexOf(attempt.submitted_at);
    if (index !== -1) weeks[index].word_count += attempt.word_count;
  }
  for (const mistake of mistakes) {
    const index = indexOf(mistake.submitted_at);
    if (index !== -1) weeks[index].error_count += 1;
  }
  return weeks;
}

// One tooltip for the whole page: it follows the pointer over, or focus on, any element with data-tip.
const tooltip = createElement('div', 'chart-tooltip');
tooltip.setAttribute('role', 'tooltip');
tooltip.hidden = true;
document.body.append(tooltip);

function showTooltip(target: HTMLElement, x: number, y: number): void {
  tooltip.textContent = target.dataset.tip ?? '';
  tooltip.hidden = false;
  const { width, height } = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2))}px`;
  tooltip.style.top = `${Math.max(8, y - height - 12)}px`;
}

document.addEventListener('pointerover', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null;
  if (target) showTooltip(target, event.clientX, event.clientY);
  else tooltip.hidden = true;
});
document.addEventListener('pointermove', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null;
  if (target) showTooltip(target, event.clientX, event.clientY);
});
document.addEventListener('focusin', (event) => {
  const target = event.target instanceof HTMLElement && event.target.dataset.tip !== undefined ? event.target : null;
  if (target === null) return;
  const box = target.getBoundingClientRect();
  showTooltip(target, box.left + box.width / 2, box.top);
});
document.addEventListener('focusout', () => { tooltip.hidden = true; });

function createStat(label: string, value: string, note: string): HTMLElement {
  const stat = createElement('div', 'stat');
  stat.append(createElement('p', 'stat-label', label), createElement('p', 'stat-value', value));
  if (note !== '') stat.append(createElement('p', 'stat-note', note));
  return stat;
}

function createStats(mistakes: ErrorLogEntry[], weeks: Week[], category_counts: [ErrorCategory, number][], selected: CategoryFilter): HTMLElement {
  const sum = (part: Week[], key: 'error_count' | 'word_count') => part.reduce((total, week) => total + week[key], 0);
  const recent = weeks.slice(-RATE_WINDOW_WEEKS);
  const before = weeks.slice(-2 * RATE_WINDOW_WEEKS, -RATE_WINDOW_WEEKS);
  const recent_rate = rateOf(sum(recent, 'error_count'), sum(recent, 'word_count'));
  const before_rate = rateOf(sum(before, 'error_count'), sum(before, 'word_count'));
  let change_note = '';
  if (recent_rate !== null && before_rate !== null) {
    const change = recent_rate - before_rate;
    change_note = Math.abs(change) < 0.05 ? 'same as the 4 weeks before'
      : `${change < 0 ? '▼' : '▲'} ${Math.abs(change).toFixed(1)} vs the 4 weeks before${change < 0 ? ' (fewer: good)' : ''}`;
  }
  const row = createElement('div', 'stats');
  row.append(
    createStat(selected === 'all' ? 'Mistakes logged' : `${categoryLabelOf(selected)} mistakes`, mistakes.length.toLocaleString('en-US'), ''),
    createStat('Per 100 words, last 4 weeks', formatRate(recent_rate), change_note),
  );
  if (selected === 'all' && category_counts.length > 0) {
    const [top_category, top_count] = category_counts[0];
    row.append(createStat('Most common', categoryLabelOf(top_category), `${top_count} of ${mistakes.length}`));
  }
  return row;
}

// Horizontal bars, longest first; clicking one filters the page to that category.
function createCategoryChart(category_counts: [ErrorCategory, number][], selected: CategoryFilter, onSelect: (category: CategoryFilter) => void): HTMLElement {
  const section = createElement('section', 'chart-section');
  section.append(createElement('h2', 'section-title', 'Most common kinds of mistake'));
  const max_count = Math.max(1, ...category_counts.map(([, count]) => count));
  const list = createElement('div', 'bar-list');
  for (const [category, count] of category_counts) {
    const row = createElement('button', `bar-row${selected !== 'all' && selected !== category ? ' is-dimmed' : ''}`);
    row.setAttribute('aria-pressed', String(selected === category));
    row.setAttribute('aria-label', `${categoryLabelOf(category)}: ${count} mistakes`);
    row.dataset.tip = `${categoryLabelOf(category)}: ${count} ${count === 1 ? 'mistake' : 'mistakes'}. Click to ${selected === category ? 'show all' : 'see only these'}.`;
    const track = createElement('span', 'bar-track');
    const bar = createElement('span', 'bar');
    bar.style.width = `${(count / max_count) * 100}%`;
    track.append(bar, createElement('span', 'bar-value', String(count)));
    row.append(createElement('span', 'bar-label', categoryLabelOf(category)), track);
    row.addEventListener('click', () => onSelect(selected === category ? 'all' : category));
    list.append(row);
  }
  section.append(list);
  return section;
}

// One column per week: errors per 100 words, so a week of essays and a week of sentences compare fairly.
function createTrendChart(weeks: Week[], selected: CategoryFilter): HTMLElement {
  const section = createElement('section', 'chart-section');
  const title = selected === 'all' ? 'Mistakes per 100 words, by week' : `${categoryLabelOf(selected)} mistakes per 100 words, by week`;
  section.append(createElement('h2', 'section-title', title));
  const rates = weeks.map((week) => rateOf(week.error_count, week.word_count));
  const max_rate = niceCeiling(Math.max(0.1, ...rates.map((rate) => rate ?? 0)));
  const chart = createElement('div', 'column-chart');
  // One hairline at the top of the scale, with its value: the axis for every column that is not labelled.
  const scale_line = createElement('div', 'scale-line');
  scale_line.append(createElement('span', 'scale-value', String(max_rate)));
  chart.append(scale_line);
  chart.setAttribute('role', 'list');
  const last_index = rates.reduce<number>((found, rate, index) => (rate === null ? found : index), -1);
  weeks.forEach((week, index) => {
    const rate = rates[index];
    const column = createElement('div', 'column');
    column.setAttribute('role', 'listitem');
    column.tabIndex = 0;
    const range = `Week of ${formatShortDate(week.start)}`;
    column.dataset.tip = rate === null ? `${range}: nothing graded`
      : `${range}: ${formatRate(rate)} per 100 words (${week.error_count} ${week.error_count === 1 ? 'mistake' : 'mistakes'} in ${week.word_count.toLocaleString('en-US')} words)`;
    column.setAttribute('aria-label', column.dataset.tip);
    const plot = createElement('div', 'column-plot');
    if (rate !== null) {
      const bar = createElement('div', 'column-bar');
      bar.style.height = `${Math.max(rate === 0 ? 0 : 2, (rate / max_rate) * 100)}%`;
      // Only the latest week is labelled; the tooltip carries the rest.
      if (index === last_index) plot.append(createElement('span', 'column-value', formatRate(rate)));
      plot.append(bar);
    }
    column.append(plot, createElement('span', 'column-label', index % 2 === (WEEK_COUNT - 1) % 2 ? formatShortDate(week.start) : ''));
    chart.append(column);
  });
  section.append(chart);
  return section;
}

function createMistakeCard(mistake: ErrorLogEntry): HTMLLIElement {
  const card = createElement('li', 'error-card log-card');
  const head = createElement('div', 'error-head');
  const fix = createElement('span', 'error-fix');
  fix.append(createElement('del', '', mistake.original), ' → ');
  fix.append(mistake.correction === '' ? createElement('em', '', '(delete)') : createElement('ins', '', mistake.correction));
  head.append(fix, createElement('span', `error-tag is-${mistake.severity}`, `${categoryLabelOf(mistake.category)} · ${mistake.severity}`));
  const rule = createElement('p', 'error-line');
  rule.append(createElement('b', '', 'Remember: '), mistake.rule);
  const why = createElement('p', 'error-line');
  why.append(createElement('b', '', 'Why: '), mistake.explanation);
  const meta = createElement('p', 'log-meta');
  const link = createElement('a', '', 'open');
  link.href = `#/attempt/${mistake.attempt_id}`;
  meta.append(`${new Date(mistake.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${mistake.exercise_id} · `, link);
  card.append(head, rule, why, meta);
  return card;
}

function createMistakeList(mistakes: ErrorLogEntry[], selected: CategoryFilter): HTMLElement {
  const section = createElement('section', 'chart-section');
  section.append(createElement('h2', 'section-title', selected === 'all' ? 'Every mistake, newest first' : `Every ${categoryLabelOf(selected).toLowerCase()} mistake, newest first`));
  const list = createElement('ol', 'error-list log-list');
  section.append(list);
  let shown_count = 0;
  const more_button = createElement('button', 'ghost-button more-button');
  const showMore = (): void => {
    list.append(...mistakes.slice(shown_count, shown_count + MISTAKES_PAGE_SIZE).map(createMistakeCard));
    shown_count = Math.min(mistakes.length, shown_count + MISTAKES_PAGE_SIZE);
    more_button.hidden = shown_count >= mistakes.length;
    more_button.textContent = `Show more (${mistakes.length - shown_count} left)`;
  };
  more_button.addEventListener('click', showMore);
  showMore();
  section.append(more_button);
  return section;
}

// Draws the filter chips into filters_element and the page into card; onSelect redraws with another category.
export function renderErrorLog(card: HTMLElement, filters_element: HTMLElement, log: ErrorLog, selected: CategoryFilter, onSelect: (category: CategoryFilter) => void): void {
  const counts = new Map<ErrorCategory, number>();
  for (const mistake of log.mistakes) counts.set(mistake.category, (counts.get(mistake.category) ?? 0) + 1);
  const category_counts = [...counts].sort((a, b) => b[1] - a[1]);
  if (selected !== 'all' && !counts.has(selected)) selected = 'all';

  filters_element.replaceChildren();
  for (const [option, count] of [['all', log.mistakes.length] as const, ...category_counts]) {
    const chip = createElement('button', 'chip', option === 'all' ? 'All' : categoryLabelOf(option));
    chip.append(createElement('span', 'chip-count', String(count)));
    chip.setAttribute('aria-pressed', String(option === selected));
    chip.addEventListener('click', () => onSelect(option));
    filters_element.append(chip);
  }

  if (log.mistakes.length === 0) {
    const empty = createElement('div', 'empty');
    empty.append(createElement('h2', '', 'No mistakes logged yet'),
      createElement('p', '', 'Every error the grader finds in your answers collects here, so you can see which kinds come back most.'));
    card.replaceChildren(empty);
    return;
  }
  const mistakes = selected === 'all' ? log.mistakes : log.mistakes.filter((mistake) => mistake.category === selected);
  const weeks = weeksOf(log, mistakes, new Date());
  const body = createElement('div', 'log-body');
  body.append(createStats(mistakes, weeks, category_counts, selected), createCategoryChart(category_counts, selected, onSelect), createTrendChart(weeks, selected), createMistakeList(mistakes, selected));
  card.replaceChildren(body);
}
