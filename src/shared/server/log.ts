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
let logFilePath: string | null = null;
let lastLoggedDateText: string | null = null;
// Set by the first failed write to logFilePath, so the terminal warns once instead of on every line.
let isLogFileFailing = false;

export function configureLogFile(path: string): void {
  logFilePath = path;
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

export function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function toOneLine(text: string, maxChars: number): string {
  const oneLineText = String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return oneLineText.length > maxChars ? `${oneLineText.slice(0, maxChars - 3)}...` : oneLineText;
}

export function lastLines(text: string, lineCount: number): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-lineCount);
}

function paint(text: string, ansiColor: string, isColor: boolean): string {
  return isColor && ansiColor !== '' ? `${ansiColor}${text}${ANSI_RESET}` : text;
}

// 5, 4 and 9 fit 'ERROR', '#999' and 'cancelled', the widest values, so the columns line up.
function formatLogLine(
  date: Date, level: LogLevel, requestNumber: number | null, eventName: string, message: string, detailLines: string[], isColor: boolean,
): string {
  const timeText = formatClockTime(date);
  const levelText = LOG_LEVEL_MARKERS[level].padEnd(5);
  const requestText = (requestNumber === null ? '' : `#${requestNumber}`).padEnd(4);
  const eventText = eventName.padEnd(9);
  const levelColor = LOG_LEVEL_COLORS[level];
  const head = [
    paint(timeText, ANSI_DIM, isColor), paint(levelText, levelColor, isColor), requestText, paint(eventText, levelColor, isColor),
  ].join(' ');
  const detailIndent = ' '.repeat([timeText, levelText, requestText, eventText].join(' ').length + 1);
  return [
    `${head} ${toOneLine(message, LOG_MESSAGE_MAX_CHARS)}`,
    ...detailLines.map((line) => `${detailIndent}| ${toOneLine(line, LOG_MESSAGE_MAX_CHARS)}`),
  ].join('\n');
}

// level: 'info' | 'warn' | 'error'; requestNumber is null for a line that belongs to no request.
// message is cut to one line; detailLines (a stderr tail, a stack) print under it, indented to its column.
export function log(level: LogLevel, requestNumber: number | null, eventName: string, message: string, detailLines: string[] = []): void {
  const now = new Date();
  const dateText = formatDateText(now);
  let terminalText = '';
  let fileText = '';
  if (dateText !== lastLoggedDateText) {
    lastLoggedDateText = dateText;
    terminalText += `${paint(`--- ${dateText} ---`, ANSI_DIM, IS_COLOR_LOG)}\n`;
    fileText += `--- ${dateText} ---\n`;
  }
  terminalText += formatLogLine(now, level, requestNumber, eventName, message, detailLines, IS_COLOR_LOG);
  fileText += `${formatLogLine(now, level, requestNumber, eventName, message, detailLines, false)}\n`;
  console.log(terminalText);
  if (logFilePath === null) return;
  try {
    appendFileSync(logFilePath, fileText);
  } catch (error) {
    // A throw here would escape a stream handler and stop the server; a log file that cannot be written must not.
    if (!isLogFileFailing) console.log(formatLogLine(now, 'warn', null, 'log', `cannot write ${logFilePath}: ${(error as Error).message}`, [], IS_COLOR_LOG));
    isLogFileFailing = true;
  }
}
