// The Practice page: a hash router. Projects and exercises are named by their keys, attempts by their number:
//   #/                  projects
//   #/new               import a file
//   #/p/<project>       the project: the next exercise
//   #/p/<project>/x/<exercise>   do an exercise
//   #/a/<attempt>       an attempt, read-only
// Each navigation aborts the previous one's requests and timers (its signal), so a slow answer can never draw over a newer page.
import { requiredElement } from '../../../shared/web/ui.ts';
import { ApiError } from './client.ts';
import { h, link } from './dom.ts';
import { showAttempt, showExercise } from './exercise.ts';
import { pageTitleOf } from './format.ts';
import { showImport } from './import-view.ts';
import type { Page } from './page.ts';
import { showProjectHome } from './project-home.ts';
import { showProjects } from './projects.ts';
import { hideSide } from './side.ts';

// A view gets the parts of the hash the pattern captured: keys, or an attempt's number as text.
type View = (page: Page, ...params: string[]) => Promise<void>;

const KEY = '([a-z0-9][a-z0-9-]{0,63})';
const ROUTES: { pattern: RegExp; view: View }[] = [
  { pattern: /^\/$/, view: showProjects },
  { pattern: /^\/new$/, view: showImport },
  { pattern: new RegExp(`^/p/${KEY}$`), view: showProjectHome },
  { pattern: new RegExp(`^/p/${KEY}/x/${KEY}$`), view: showExercise },
  { pattern: /^\/a\/(\d{1,9})$/, view: showAttempt },
];

const main = requiredElement('#main', HTMLElement);
let navigation: AbortController | null = null;
let isFirstPage = true;

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
    const params = route.match!.slice(1);
    await route.view(page, ...params);
    if (!own.signal.aborted && !isFirstPage) main.focus({ preventScroll: true });
    isFirstPage = false;
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
