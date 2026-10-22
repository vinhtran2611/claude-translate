// The words of the error alert: a title and a sentence for each way a translation can fail.
import type { CliErrorCode } from '../../../shared/api-types.ts';

// The server's error kinds, plus the two the page detects itself.
export type PageErrorKind = CliErrorCode | 'server_unreachable' | 'request_rejected';

// silenceText: who sent nothing (see silenceTextOf in translate.ts); used only by 'no_response'.
export function alertForError(errorKind: PageErrorKind, message: string, hasPartialTranslation: boolean, silenceText: string): { title: string; body: string } {
  const keptNote = hasPartialTranslation ? ' What arrived so far is kept.' : '';
  switch (errorKind) {
    case 'no_response':
      return {
        title: "Claude didn't respond",
        body: `${silenceText} This is usually a short API or network hiccup; trying again a moment later normally works.`,
      };
    case 'stalled':
      return { title: 'Claude stopped mid-translation', body: `The reply stopped arriving.${keptNote}` };
    case 'claude_error':
      if (/authenticat|log ?in|oauth/i.test(message)) {
        return { title: 'Claude CLI is not logged in', body: 'Run `claude auth login` in a terminal, then try again.' };
      }
      return { title: 'Claude returned an error', body: `The translation could not finish.${keptNote}` };
    case 'output_limit':
      return { title: 'The translation was cut off', body: `The text is too long for one reply.${keptNote} Translate the rest separately.` };
    case 'server_unreachable':
      return { title: "Can't reach the translation server", body: 'Check that `npm start` is still running in its terminal, then try again.' };
    case 'request_rejected':
      return { title: 'The server rejected the request', body: 'The text could not be sent for translation.' };
    default:
      return { title: "Couldn't run Claude", body: `The claude process failed.${keptNote}` };
  }
}
