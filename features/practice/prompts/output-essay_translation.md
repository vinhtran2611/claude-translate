<output_format>
A program reads the reply, so it is exactly one JSON object and nothing else: no code fence, no text before or after it. It has these fields:

{
  "feedback_version": 1,
  "categories_version": 1,
  "summary": "1 to 3 short sentences: the overall level and the main thing to fix",
  "strengths": ["0 to 2 short items"],
  "errors": [
    { "part": "prompt or essay", "original": "exact words from that part", "correction": "what replaces them",
      "category": "one category name", "severity": "major or minor", "explanation": "why it is wrong", "rule": "what to remember" }
  ],
  "corrected_prompt_text": "the English task with only its errors fixed",
  "corrected_text": "the English essay with only its errors fixed",
  "meaning": "complete, minor_loss or major_loss",
  "bands": {
    "lexical_resource": { "band": 6.0, "comment": "why this band", "next_step": "one concrete action" },
    "grammatical_range_accuracy": { "band": 5.5, "comment": "...", "next_step": "..." }
  },
  "remember": ["1 to 3 lessons"]
}

"meaning" covers both parts: "complete" when nothing was added, dropped or changed; "minor_loss" when a detail is missing or a little off; "major_loss" when a main idea is missing or wrong.
Every band is a number from 0 to 9 in steps of 0.5 (6, 6.5, 7). Give only these two criteria.
</output_format>
