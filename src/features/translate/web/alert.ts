// The page's one alert: a popover at the bottom with a title, a body, the raw detail and at most one button. What it
// says for each error is in alert-text.ts.
import { requiredElement } from '../../../shared/web/ui.ts';

export interface AlertAction {
  label: string;
  run: () => void;
}

const alert_box = requiredElement('#alert', HTMLDivElement);
const alert_title = requiredElement('#alert-title', HTMLDivElement);
const alert_body = requiredElement('#alert-body', HTMLDivElement);
const alert_detail = requiredElement('#alert-detail', HTMLDivElement);
const alert_action_button = requiredElement('#alert-action-button', HTMLButtonElement);
// What the alert's button does while this alert is shown; written only by showAlert.
let alert_action: AlertAction | null = null;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// detail is the raw message, shown small so the cause is never hidden. action: null for no button.
export function showAlert({ severity, title, body = '', detail = '', action = null }: {
  severity: 'error' | 'warning' | 'info'; title: string; body?: string; detail?: string; action?: AlertAction | null;
}): void {
  alert_box.className = `alert is-${severity}`;
  alert_title.textContent = title;
  alert_body.textContent = body;
  alert_body.hidden = body === '';
  alert_detail.textContent = detail;
  alert_action = action;
  alert_action_button.hidden = action === null;
  alert_action_button.textContent = action?.label ?? '';
  // Hiding first re-inserts it at the top of the top layer, above a drawer opened since it was last shown.
  if (alert_box.matches(':popover-open')) alert_box.hidePopover();
  alert_box.showPopover();
}

export function hideAlert(): void {
  if (alert_box.matches(':popover-open')) alert_box.hidePopover();
  alert_action = null;
}

export function isAlertShown(): boolean {
  return alert_box.matches(':popover-open');
}

alert_action_button.addEventListener('click', () => {
  const action = alert_action;
  hideAlert();
  action?.run();
});
requiredElement('#alert-close-button', HTMLButtonElement).addEventListener('click', hideAlert);
