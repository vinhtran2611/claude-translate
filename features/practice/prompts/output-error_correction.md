<output_format>
A program reads the reply, so it is exactly one JSON object and nothing else: no code fence, no text before or after it. It has these fields:

{
  "feedback_version": 1,
  "categories_version": 1,
  "summary": "1 to 3 short sentences: how many planted mistakes were found and the main thing to learn",
  "strengths": ["0 to 2 short items"],
  "key_results": [
    { "mistake_index": 0, "status": "fixed, partly or missed", "learner_text": "what the learner's text says there now", "comment": "only for partly or missed" }
  ],
  "errors": [
    { "original": "exact words from the learner's text", "correction": "what replaces them", "category": "one category name",
      "severity": "major or minor", "explanation": "why it is wrong", "rule": "what to remember" }
  ],
  "corrected_text": "the learner's text with only the remaining errors fixed",
  "remember": ["1 to 3 lessons"]
}

"key_results" has exactly one entry per planted mistake, in the listed order: mistake_index 0, 1, 2 and so on. "errors" is empty when every planted mistake was fixed and nothing new went wrong.
</output_format>
