// The page's one alert: a popover at the bottom with a title, a body, the raw detail and at most one button. What it
// says for each error is in alert-text.ts.
import { requiredElement } from '../../../shared/web/ui.ts';

interface AlertAction {
  label: string;
  run: () => void;
}

const alertBox = requiredElement('#alert', HTMLDivElement);
const alertTitle = requiredElement('#alert-title', HTMLDivElement);
const alertBody = requiredElement('#alert-body', HTMLDivElement);
const alertDetail = requiredElement('#alert-detail', HTMLDivElement);
const alertActionButton = requiredElement('#alert-action-button', HTMLButtonElement);
// What the alert's button does while this alert is shown; written only by showAlert.
let alertAction: AlertAction | null = null;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// detail is the raw message, shown small so the cause is never hidden. action: null for no button.
export function showAlert({ severity, title, body = '', detail = '', action = null }: {
  severity: 'error' | 'warning' | 'info'; title: string; body?: string; detail?: string; action?: AlertAction | null;
}): void {
  alertBox.className = `alert is-${severity}`;
  alertTitle.textContent = title;
  alertBody.textContent = body;
  alertBody.hidden = body === '';
  alertDetail.textContent = detail;
  alertAction = action;
  alertActionButton.hidden = action === null;
  alertActionButton.textContent = action?.label ?? '';
  // Hiding first re-inserts it at the top of the top layer, above a drawer opened since it was last shown.
  if (alertBox.matches(':popover-open')) alertBox.hidePopover();
  alertBox.showPopover();
}

export function hideAlert(): void {
  if (alertBox.matches(':popover-open')) alertBox.hidePopover();
  alertAction = null;
}

export function isAlertShown(): boolean {
  return alertBox.matches(':popover-open');
}

alertActionButton.addEventListener('click', () => {
  const action = alertAction;
  hideAlert();
  action?.run();
});
requiredElement('#alert-close-button', HTMLButtonElement).addEventListener('click', hideAlert);
