// #/new and #/p/<project>/add : choose or paste a project file, see what it holds or what is wrong with it, then import.
// The file is checked in the page with the same code the server runs again before it stores anything.
import { createIcon } from '../../../shared/web/ui.ts';
import type { ExerciseType, Project } from '../api.ts';
import { checkProjectFile, MAX_FILE_CHARS, problemLine, type CheckedFile, type Problem } from '../import-check.ts';
import { addExercises, createProject, listProjects, problemsOf, readProject } from './client.ts';
import { button, h, link } from './dom.ts';
import { pluralize, typeMix } from './format.ts';
import type { Page } from './page.ts';
import { showProjectsSide, showSide } from './side.ts';

const PASTE_CHECK_DELAY_MS = 300;

// The exercises of a file's text, to name the one a problem is in; null when it is not JSON.
function exercisesOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { exercises?: unknown }).exercises;
  } catch {
    return null;
  }
}

// "content.options" in a problem line, set in code type.
function describeProblem(problem: string): (Node | string)[] {
  return problem.split(/(\bcontent(?:\.\w+|\[\d+\])+)/).map((part, index) => (index % 2 === 1 ? h('code', '', part) : part));
}

function createProblems(problems: string[]): HTMLElement {
  const copy = button('secondary-button', 'Copy problems', () => {
    navigator.clipboard?.writeText(problems.join('\n')).then(() => { copy.textContent = 'Copied'; }, () => {});
  });
  return Object.assign(h('div', 'problems',
    h('h2', '', `Nothing was imported. ${pluralize(problems.length, 'problem')} found.`),
    h('ol', '', ...problems.map((problem) => h('li', '', ...describeProblem(problem)))),
    h('p', '', 'Fix the file and choose it again.'), copy), { role: 'alert' });
}

function createFound(checked: CheckedFile & { file: object }): HTMLElement {
  const counts: Partial<Record<ExerciseType, number>> = {};
  for (const { type } of checked.file.exercises) counts[type] = (counts[type] ?? 0) + 1;
  return Object.assign(h('div', 'found', h('strong', '', `✓ ${pluralize(checked.file.exercises.length, 'exercise')} found`), h('small', '', typeMix(counts))), { role: 'status' });
}

// project: null makes a new project; otherwise the file's exercises are added to it.
function drawImport(page: Page, project: Project | null): void {
  let checked: CheckedFile | null = null;
  let source_text = '';
  let file_label: { name: string; size: number } | null = null;
  // The problems the server found in a file the page found fine.
  let rejected: Problem[] | null = null;
  let is_name_edited = false;
  let paste_timer: ReturnType<typeof setTimeout> | undefined;
  page.signal.addEventListener('abort', () => clearTimeout(paste_timer));

  const name = Object.assign(h('input', 'field'), { id: 'project-name', maxLength: 80 });
  const description = Object.assign(h('textarea', 'field'), { id: 'project-description', rows: 2, maxLength: 500 });
  const paste = Object.assign(h('textarea', 'field'), { id: 'paste-json', rows: 10, spellcheck: false, hidden: true });
  const paste_label = Object.assign(h('label', 'field-label', 'Paste JSON'), { htmlFor: 'paste-json', hidden: true });
  const picker = Object.assign(h('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  const zone = h('div', 'drop-zone');
  const result = h('div');
  const submit = Object.assign(h('button', 'primary-button'), { type: 'button' as const });
  const paste_toggle = h('button', 'link-button', 'paste JSON');

  function draw(): void {
    const file = checked?.file ?? null;
    const choose = button('secondary-button', file_label === null ? 'Choose file' : 'Choose another file', () => picker.click());
    zone.replaceChildren(h('div', 'grow', ...(file_label === null ? [h('span', '', 'No file chosen')] : [h('strong', '', file_label.name), h('span', '', ` · ${Math.max(1, Math.round(file_label.size / 1024))} KB`)])), choose);
    const lines = (problems: Problem[]) => problems.map((problem) => problemLine(problem, exercisesOf(source_text)));
    const shown = rejected !== null ? createProblems(lines(rejected)) : checked === null ? null
      : checked.file !== null ? createFound(checked as CheckedFile & { file: object }) : createProblems(lines(checked.problems));
    result.replaceChildren(...(shown === null ? [] : [shown]));
    const is_ready = file !== null && rejected === null && (project !== null || name.value.trim() !== '');
    submit.disabled = !is_ready;
    submit.textContent = file === null ? (project === null ? 'Create project' : 'Add') : `${project === null ? 'Import' : 'Add'} ${pluralize(file.exercises.length, 'exercise')}`;
  }

  function check(text: string, label: typeof file_label): void {
    source_text = text;
    file_label = label;
    checked = checkProjectFile(text);
    rejected = null;
    if (checked.file !== null && project === null && !is_name_edited) name.value = checked.file.name;
    draw();
  }

  let load_count = 0;
  async function loadFile(file: File): Promise<void> {
    const own = ++load_count;
    paste.value = '';
    if (file.size > MAX_FILE_CHARS) {
      checked = { file: null, problems: [{ path: '', code: 'too_large', message: 'The file is larger than 2 MB.' }] };
      file_label = { name: file.name, size: file.size };
      rejected = null;
      return draw();
    }
    const text = await file.text();
    if (own === load_count && !page.signal.aborted) check(text, { name: file.name, size: file.size });
  }

  picker.addEventListener('change', () => { if (picker.files?.[0]) void loadFile(picker.files[0]); picker.value = ''; });
  paste_toggle.addEventListener('click', () => {
    paste.hidden = paste_label.hidden = false;
    paste.focus();
  });
  paste.addEventListener('input', () => {
    clearTimeout(paste_timer);
    load_count++;
    paste_timer = setTimeout(() => check(paste.value, null), PASTE_CHECK_DELAY_MS);
  });
  name.addEventListener('input', () => { is_name_edited = true; draw(); });
  const card = h('section', 'workspace');
  card.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-over'); });
  card.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-over');
    if (event.dataTransfer?.files[0]) void loadFile(event.dataTransfer.files[0]);
  });
  submit.addEventListener('click', async () => {
    if (checked?.file == null) return;
    submit.disabled = true;
    try {
      const body = { name: name.value, description: description.value, file: source_text };
      const id = project === null ? (await createProject(body, page.signal)).id : (await addExercises(project.id, { file: source_text }, page.signal), project.id);
      location.hash = `#/p/${id}`;
    } catch (error) {
      if (page.signal.aborted) return;
      // The server's paths point into the body, whose file is under /file.
      rejected = problemsOf(error).map((problem) => ({ ...problem, path: problem.path.replace(/^\/file/, '') }));
      draw();
    }
  });

  const label = (text: string, input: HTMLElement, optional = false) =>
    Object.assign(h('label', 'field-label', text, ...(optional ? [' ', h('small', '', '(optional)')] : [])), { htmlFor: input.id });
  const file_pane = h('div', 'pane', h('div', 'pane-body',
    h('p', 'field-label', 'Exercises file'), zone, picker,
    h('p', 'drop-hint', 'Drop a .json file here, or ', paste_toggle, '.'), paste_label, paste, result,
    h('div', 'links',
      Object.assign(link('/practice/format-guide.md', '', 'File format guide'), { target: '_blank', rel: 'noopener' }),
      Object.assign(link('/practice/example-project.json', '', 'Download an example file'), { download: 'example-project.json' }))));
  const actions = h('div', 'bar-actions', link(project === null ? '#/' : `#/p/${project.id}`, 'ghost-button', 'Cancel'), submit);
  const heading = (role: string, name: string) => h('div', 'direction-label', h('span', 'direction-role', role), h('span', 'language-name', name));
  card.append(project === null
    ? h('div', 'direction-bar', h('div', 'bar-half is-tinted', heading('New', 'project')), h('div', 'bar-half is-actions', heading('Exercises', 'file'), actions))
    : h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', heading('Add to', project.name), actions)),
    project === null
      ? h('div', 'panes', h('div', 'pane is-problem', h('div', 'pane-body', label('Project name', name), name, label('Description', description, true), description)), file_pane)
      : h('div', 'panes is-single', file_pane));
  page.main.append(
    h('nav', 'settings-bar', link('#/', 'settings-chip', createIcon('back', 'chip-icon'), 'Projects'),
      ...(project === null ? [] : [link(`#/p/${project.id}`, 'settings-chip is-name', h('span', '', project.name))])),
    card);
  draw();
}

export async function showNewProject(page: Page): Promise<void> {
  showProjectsSide(await listProjects(page.signal));
  page.setTitle('New project');
  drawImport(page, null);
}

export async function showAddExercises(page: Page, project_id: number): Promise<void> {
  const detail = await readProject(project_id, page.signal);
  showSide(detail, {});
  page.setTitle('Add exercises');
  drawImport(page, detail.project);
}
