// The Practice page: a hash router. Routes (the first match wins):
//   #/                  projects            #/a/<attempt>          an attempt, read-only
//   #/new               new project         #/p/<project>/x/<ex>   do an exercise
//   #/p/<project>       next exercise       #/p/<project>/add      add exercises
// Each navigation aborts the previous one's requests and timers (its signal), so a slow answer can never draw over a newer page.
import { requiredElement } from '../../../shared/web/ui.ts';
import { ApiError } from './client.ts';
import { h, link } from './dom.ts';
import { showAttempt, showExercise } from './exercise.ts';
import { pageTitleOf } from './format.ts';
import { showAddExercises, showNewProject } from './import-view.ts';
import type { Page } from './page.ts';
import { showProjectHome } from './project-home.ts';
import { showProjects } from './projects.ts';
import { hideSide } from './side.ts';

type View = (page: Page, ...ids: number[]) => Promise<void>;

const ROUTES: { pattern: RegExp; view: View }[] = [
  { pattern: /^\/$/, view: showProjects },
  { pattern: /^\/new$/, view: showNewProject },
  { pattern: /^\/p\/(\d{1,9})$/, view: showProjectHome },
  { pattern: /^\/p\/(\d{1,9})\/add$/, view: showAddExercises },
  { pattern: /^\/p\/(\d{1,9})\/x\/(\d{1,9})$/, view: showExercise },
  { pattern: /^\/a\/(\d{1,9})$/, view: showAttempt },
];

const main = requiredElement('#main', HTMLElement);
let navigation: AbortController | null = null;
let is_first_page = true;

function showMessage(title: string, ...children: (Node | string)[]): void {
  hideSide();
  document.title = pageTitleOf(title);
  main.replaceChildren(h('h1', '', title), ...children.map((child) => (typeof child === 'string' ? h('p', 'evaluation-note', child) : child)));
}

async function navigate(): Promise<void> {
  navigation?.abort();
  const own = new AbortController();
  navigation = own;
  const path = location.hash.replace(/^#/, '') || '/';
  const route = ROUTES.map((candidate) => ({ ...candidate, match: candidate.pattern.exec(path) })).find(({ match }) => match !== null);
  main.replaceChildren();
  window.scrollTo(0, 0);
  if (route === undefined) return showMessage('Page not found', 'There is nothing at this address.', link('#/', '', '← Back to Projects'));
  const page: Page = { main, signal: own.signal, setTitle: (view) => { document.title = pageTitleOf(view); } };
  try {
    await route.view(page, ...route.match!.slice(1).map(Number));
    if (!own.signal.aborted && !is_first_page) main.focus({ preventScroll: true });
    is_first_page = false;
  } catch (error) {
    if (own.signal.aborted) return;
    if (error instanceof ApiError && error.status === 404) {
      showMessage('Not found', 'This project, exercise or attempt does not exist.', link('#/', '', '← Back to Projects'));
    } else {
      showMessage('Something went wrong', (error as Error).message, Object.assign(h('button', 'secondary-button', 'Try again'), { type: 'button' as const, onclick: () => void navigate() }));
    }
  }
}

window.addEventListener('hashchange', () => void navigate());
void navigate();
