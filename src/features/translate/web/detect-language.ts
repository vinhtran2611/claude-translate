// Which language the typed text is in, so the page can pick the translation direction by itself.
import type { Language } from '../api-types.ts';

const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const ENGLISH_FUNCTION_WORDS = new Set([
  'the', 'a', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'our', 'their', 'me', 'us', 'them', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'not', 'if', 'so', 'as', 'just', 'about', 'into', 'than', 'then', 'there', 'here', 'some',
  'any', 'all', 'let',
]);
// Quoted text and code are often in the other language, so they do not count.
const QUOTED_OR_CODE = /"[^"]*"|“[^”]*”|`[^`]*`/g;

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => /\p{L}/u.test(word));
}

// The share of accented words alone cannot separate code-mixed Vietnamese ("anh check giúp em latency p99", 0.29)
// from English naming a person or dish ("Thanks Nguyễn Văn An for the review", 0.29); function words break the tie.
export function detectSourceLanguage(text: string): Language {
  const unquoted_words = wordsOf(text.replace(QUOTED_OR_CODE, ' '));
  const words = unquoted_words.length > 0 ? unquoted_words : wordsOf(text);
  const vietnamese_word_count = words.filter((word) => VIETNAMESE_LETTER.test(word)).length;
  const english_function_word_count = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  return vietnamese_word_count > english_function_word_count ? 'vi' : 'en';
}
