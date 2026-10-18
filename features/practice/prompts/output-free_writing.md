<output_format>
A program reads the reply, so it is exactly one JSON object and nothing else: no code fence, no text before or after it. It has these fields:

{
  "feedback_version": 1,
  "categories_version": 1,
  "summary": "1 to 3 short sentences: the overall level and the main thing to fix",
  "strengths": ["0 to 2 short items"],
  "errors": [
    { "original": "exact words from the essay", "correction": "what replaces them", "category": "one category name",
      "severity": "major or minor", "explanation": "why it is wrong", "rule": "what to remember" }
  ],
  "corrected_text": "the essay with only the language errors fixed",
  "bands": {
    "task_response": { "band": 6.0, "comment": "why this band", "next_step": "one concrete action" },
    "coherence_cohesion": { "band": 6.5, "comment": "...", "next_step": "..." },
    "lexical_resource": { "band": 6.0, "comment": "...", "next_step": "..." },
    "grammatical_range_accuracy": { "band": 5.5, "comment": "...", "next_step": "..." }
  },
  "remember": ["1 to 3 lessons"]
}

Every band is a number from 0 to 9 in steps of 0.5 (6, 6.5, 7). Do not add an overall band: the app computes it.
</output_format>
