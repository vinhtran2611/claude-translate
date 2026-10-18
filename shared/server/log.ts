// The server log, shared by every feature: one line per event on the terminal (coloured when it can) and the same
// lines, uncoloured, appended to the log file set by configureLogFile.
import { appendFileSync } from 'node:fs';

export type LogLevel = 'info' | 'warn' | 'error';

// Arbitrary: enough of a stderr tail or a stack to name the problem without burying the lines after it.
export const LOG_DETAIL_MAX_LINES = 6;
// Arbitrary: room for a whole error sentence; a raw blob is cut instead of flooding the terminal.
const LOG_MESSAGE_MAX_CHARS = 300;
const LOG_LEVEL_MARKERS: Record<LogLevel, string> = { info: '', warn: 'WARN', error: 'ERROR' };
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ANSI_DIM = '\x1b[2m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BOLD_RED = '\x1b[1;31m';
const ANSI_RESET = '\x1b[0m';
const LOG_LEVEL_COLORS: Record<LogLevel, string> = { info: '', warn: ANSI_YELLOW, error: ANSI_BOLD_RED };
// hasColors() already honours NO_COLOR and TERM=dumb; a pipe or a file is not a TTY and gets plain text.
const IS_COLOR_LOG = process.stdout.isTTY === true && process.stdout.hasColors();

// null until configureLogFile: lines then go to the terminal only.
let log_file_path: string | null = null;
let last_logged_date_text: string | null = null;
// Set by the first failed write to log_file_path, so the terminal warns once instead of on every line.
let is_log_file_failing = false;

export function configureLogFile(path: string): void {
  log_file_path = path;
}

function padTwoDigits(number: number): string {
  return String(number).padStart(2, '0');
}

function formatClockTime(date: Date): string {
  return `${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}:${padTwoDigits(date.getSeconds())}`;
}

function formatDateText(date: Date): string {
  return `${WEEKDAY_NAMES[date.getDay()]} ${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`;
}

export function formatWeekdayTime(date: Date): string {
  return `${WEEKDAY_NAMES[date.getDay()]} ${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
}

export function formatSeconds(duration_ms: number): string {
  return `${(duration_ms / 1000).toFixed(1)}s`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function toOneLine(text: string, max_chars: number): string {
  const one_line_text = String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return one_line_text.length > max_chars ? `${one_line_text.slice(0, max_chars - 3)}...` : one_line_text;
}

export function lastLines(text: string, line_count: number): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-line_count);
}

function paint(text: string, ansi_color: string, is_color: boolean): string {
  return is_color && ansi_color !== '' ? `${ansi_color}${text}${ANSI_RESET}` : text;
}

// 5, 4 and 9 fit 'ERROR', '#999' and 'cancelled', the widest values, so the columns line up.
function formatLogLine(
  date: Date, level: LogLevel, request_number: number | null, event_name: string, message: string, detail_lines: string[], is_color: boolean,
): string {
  const time_text = formatClockTime(date);
  const level_text = LOG_LEVEL_MARKERS[level].padEnd(5);
  const request_text = (request_number === null ? '' : `#${request_number}`).padEnd(4);
  const event_text = event_name.padEnd(9);
  const level_color = LOG_LEVEL_COLORS[level];
  const head = [
    paint(time_text, ANSI_DIM, is_color), paint(level_text, level_color, is_color), request_text, paint(event_text, level_color, is_color),
  ].join(' ');
  const detail_indent = ' '.repeat([time_text, level_text, request_text, event_text].join(' ').length + 1);
  return [
    `${head} ${toOneLine(message, LOG_MESSAGE_MAX_CHARS)}`,
    ...detail_lines.map((line) => `${detail_indent}| ${toOneLine(line, LOG_MESSAGE_MAX_CHARS)}`),
  ].join('\n');
}

// level: 'info' | 'warn' | 'error'; request_number is null for a line that belongs to no request.
// message is cut to one line; detail_lines (a stderr tail, a stack) print under it, indented to its column.
export function log(level: LogLevel, request_number: number | null, event_name: string, message: string, detail_lines: string[] = []): void {
  const now = new Date();
  const date_text = formatDateText(now);
  let terminal_text = '';
  let file_text = '';
  if (date_text !== last_logged_date_text) {
    last_logged_date_text = date_text;
    terminal_text += `${paint(`--- ${date_text} ---`, ANSI_DIM, IS_COLOR_LOG)}\n`;
    file_text += `--- ${date_text} ---\n`;
  }
  terminal_text += formatLogLine(now, level, request_number, event_name, message, detail_lines, IS_COLOR_LOG);
  file_text += `${formatLogLine(now, level, request_number, event_name, message, detail_lines, false)}\n`;
  console.log(terminal_text);
  if (log_file_path === null) return;
  try {
    appendFileSync(log_file_path, file_text);
  } catch (error) {
    // A throw here would escape a stream handler and stop the server; a log file that cannot be written must not.
    if (!is_log_file_failing) console.log(formatLogLine(now, 'warn', null, 'log', `cannot write ${log_file_path}: ${(error as Error).message}`, [], IS_COLOR_LOG));
    is_log_file_failing = true;
  }
}
