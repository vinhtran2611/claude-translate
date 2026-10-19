// #/new : choose or paste a project file, see what it holds or what is wrong with it, then import it. The file names its
// project (project.key): a new key makes a project, a key that exists updates that project in place.
// The file is checked in the page with the same code the server runs again before it stores anything.
import { createIcon } from '../../../shared/web/ui.ts';
import type { ExerciseType, ProjectFile } from '../api.ts';
import { checkProjectFile, MAX_FILE_CHARS, problemLine, type Problem } from '../import-check.ts';
import { importFile, listProjects, problemsOf } from './client.ts';
import { button, h, link } from './dom.ts';
import { pluralize, typeMix } from './format.ts';
import type { Page } from './page.ts';
import { showProjectsSide } from './side.ts';

const PASTE_CHECK_DELAY_MS = 300;

// What the page knows about the file now.
type State =
  | { kind: 'empty' }
  | { kind: 'problems'; problems: Problem[]; text: string }
  | { kind: 'ready'; file: ProjectFile; text: string };

// The exercises of a file's text, to name the one a problem is in; null when it is not JSON.
function exercisesOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { exercises?: unknown }).exercises;
  } catch {
    return null;
  }
}

// "content.options" in a problem line, set in code type.
function describeProblem(line: string): (Node | string)[] {
  const parts = line.split(/(\bcontent(?:\.\w+|\[\d+\])+)/);
  return parts.map((part, index) => (index % 2 === 1 ? h('code', '', part) : part));
}

function createProblems(problems: Problem[], text: string): HTMLElement {
  const exercises = exercisesOf(text);
  const lines = problems.map((problem) => problemLine(problem, exercises));
  const copy = button('secondary-button', 'Copy problems', () => {
    navigator.clipboard?.writeText(lines.join('\n')).then(() => { copy.textContent = 'Copied'; }, () => {});
  });
  const list = h('ol', '', ...lines.map((line) => h('li', '', ...describeProblem(line))));
  const heading = h('h2', '', `Nothing was imported. ${pluralize(lines.length, 'problem')} found.`);
  return Object.assign(h('div', 'problems', heading, list, h('p', '', 'Fix the file and choose it again.'), copy), { role: 'alert' });
}

function createFound(file: ProjectFile): HTMLElement {
  const counts: Partial<Record<ExerciseType, number>> = {};
  for (const exercise of file.exercises) counts[exercise.type] = (counts[exercise.type] ?? 0) + 1;
  const title = h('strong', '', `✓ ${pluralize(file.exercises.length, 'exercise')} for “${file.name}”`);
  const details = h('small', '', `Project key ${file.key} · ${typeMix(counts)}`);
  return Object.assign(h('div', 'found', title, details), { role: 'status' });
}

export async function showImport(page: Page): Promise<void> {
  showProjectsSide(await listProjects('false', page.signal));
  page.setTitle('Import a file');

  let state: State = { kind: 'empty' };
  let file_label: { name: string; size: number } | null = null;
  let paste_timer: ReturnType<typeof setTimeout> | undefined;
  page.signal.addEventListener('abort', () => clearTimeout(paste_timer));

  const paste = Object.assign(h('textarea', 'field'), { id: 'paste-json', rows: 10, spellcheck: false, hidden: true });
  const paste_label = Object.assign(h('label', 'field-label', 'Paste JSON'), { htmlFor: 'paste-json', hidden: true });
  const paste_toggle = h('button', 'link-button', 'paste JSON');
  const picker = Object.assign(h('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  const zone = h('div', 'drop-zone');
  const result = h('div');
  const submit = Object.assign(h('button', 'primary-button', 'Import'), { type: 'button' as const });

  function draw(): void {
    const choose = button('secondary-button', file_label === null ? 'Choose file' : 'Choose another file', () => picker.click());
    const label = file_label === null
      ? [h('span', '', 'No file chosen')]
      : [h('strong', '', file_label.name), h('span', '', ` · ${Math.max(1, Math.round(file_label.size / 1024))} KB`)];
    zone.replaceChildren(h('div', 'grow', ...label), choose);

    if (state.kind === 'empty') result.replaceChildren();
    if (state.kind === 'problems') result.replaceChildren(createProblems(state.problems, state.text));
    if (state.kind === 'ready') result.replaceChildren(createFound(state.file));

    submit.disabled = state.kind !== 'ready';
    submit.textContent = state.kind === 'ready' ? `Import ${pluralize(state.file.exercises.length, 'exercise')}` : 'Import';
  }

  function check(text: string, label: typeof file_label): void {
    file_label = label;
    const checked = checkProjectFile(text);
    state = checked.file === null ? { kind: 'problems', problems: checked.problems, text } : { kind: 'ready', file: checked.file, text };
    draw();
  }

  // Each new file or paste counts; an older read that ends late is dropped.
  let load_count = 0;
  async function loadFile(chosen: File): Promise<void> {
    const own = ++load_count;
    paste.value = '';
    if (chosen.size > MAX_FILE_CHARS) {
      file_label = { name: chosen.name, size: chosen.size };
      state = { kind: 'problems', problems: [{ path: '', code: 'too_large', message: 'The file is larger than 2 MB.' }], text: '' };
      draw();
      return;
    }
    const text = await chosen.text();
    if (own === load_count && !page.signal.aborted) check(text, { name: chosen.name, size: chosen.size });
  }

  async function send(): Promise<void> {
    if (state.kind !== 'ready') return;
    const { text } = state;
    submit.disabled = true;
    try {
      const imported = await importFile(JSON.parse(text), page.signal);
      location.hash = `#/p/${imported.project.key}`;
    } catch (error) {
      if (page.signal.aborted) return;
      // The server found problems the page did not (it should not happen: they run the same check).
      state = { kind: 'problems', problems: problemsOf(error), text };
      draw();
    }
  }

  picker.addEventListener('change', () => {
    if (picker.files?.[0]) void loadFile(picker.files[0]);
    picker.value = '';
  });
  paste_toggle.addEventListener('click', () => {
    paste.hidden = false;
    paste_label.hidden = false;
    paste.focus();
  });
  paste.addEventListener('input', () => {
    clearTimeout(paste_timer);
    load_count++;
    paste_timer = setTimeout(() => check(paste.value, null), PASTE_CHECK_DELAY_MS);
  });
  submit.addEventListener('click', () => void send());

  const card = h('section', 'workspace');
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-over');
  });
  card.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-over');
    if (event.dataTransfer?.files[0]) void loadFile(event.dataTransfer.files[0]);
  });

  const guide = Object.assign(link('/practice/format-guide.md', '', 'File format guide'), { target: '_blank', rel: 'noopener' });
  const example = Object.assign(link('/practice/example-project.json', '', 'Download an example file'), { download: 'example-project.json' });
  const hint = h('p', 'drop-hint', 'Drop a .json file here, or ', paste_toggle, '. Importing a file again updates its project.');
  const file_pane = h('div', 'pane', h('div', 'pane-body',
    h('p', 'field-label', 'Exercises file'), zone, picker, hint, paste_label, paste, result, h('div', 'links', guide, example)));

  const heading = h('div', 'direction-label', h('span', 'direction-role', 'Import'), h('span', 'language-name', 'a project file'));
  const actions = h('div', 'bar-actions', link('#/', 'ghost-button', 'Cancel'), submit);
  card.append(h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', heading, actions)), h('div', 'panes is-single', file_pane));

  const back = link('#/', 'settings-chip', createIcon('back', 'chip-icon'), 'Projects');
  page.main.append(h('nav', 'settings-bar', back), card);
  draw();
}
