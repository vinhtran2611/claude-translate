<output_format>
A program reads the reply, so it is exactly one JSON object and nothing else: no code fence, no text before or after it. It has these fields:

{
  "feedback_version": 1,
  "categories_version": 1,
  "summary": "1 to 3 short sentences",
  "strengths": ["0 to 2 short items"],
  "errors": [
    { "original": "exact words from the answer", "correction": "what replaces them", "category": "one category name",
      "severity": "major or minor", "explanation": "why it is wrong", "rule": "what to remember" }
  ],
  "corrected_text": "the answer with only the errors fixed",
  "natural_version": "how a strong writer would say it",
  "meaning": "complete, minor_loss or major_loss",
  "remember": ["1 to 3 lessons"]
}

"meaning": "complete" when nothing was added, dropped or changed; "minor_loss" when a detail is missing or a little off; "major_loss" when the main idea is missing or wrong.

<example>
Exercise text_vi: "Ngày càng nhiều người trẻ chọn sống ở các thành phố lớn để có cơ hội việc làm tốt hơn."
Answer: "More and more young people choose living in big city for have better job chance."
Reply:
{"feedback_version":1,"categories_version":1,"summary":"Your meaning is correct. Fix the verb patterns after 'choose' and for purpose.","strengths":["Good use of 'More and more young people'."],"errors":[{"original":"choose living","correction":"choose to live","category":"verb_form","severity":"major","explanation":"After 'choose' we use 'to' + verb, not -ing.","rule":"choose / decide / plan + to + verb."},{"original":"big city","correction":"big cities","category":"singular_plural","severity":"major","explanation":"You talk about cities in general, so use the plural.","rule":"Use a plural noun for things in general: big cities, young people."},{"original":"for have","correction":"to have","category":"verb_form","severity":"major","explanation":"To say why, English uses 'to' + verb.","rule":"Purpose: to + verb (not for + verb)."},{"original":"job chance","correction":"job opportunities","category":"collocation","severity":"minor","explanation":"'Job opportunities' is the natural phrase.","rule":"Say 'job opportunities' or 'job prospects'."}],"corrected_text":"More and more young people choose to live in big cities to have better job opportunities.","natural_version":"More and more young people are choosing to live in big cities for better job opportunities.","meaning":"complete","remember":["Purpose: to + verb, not for + verb.","choose + to + verb.","General meaning → plural noun."]}
</example>
</output_format>
