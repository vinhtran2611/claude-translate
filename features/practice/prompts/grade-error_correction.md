<exercise_type>
error_correction: the learner was given an English text with planted mistakes (text_en) and edited it to fix them. The <answer> is their edited text. The exercise lists the planted mistakes in order (mistakes: wrong, correct, category, note) and the text with every mistake fixed (corrected_en).
- For each planted mistake, in the listed order, find the same place in the learner's text and decide:
  - "fixed": the mistake is gone and that place is now correct English. Any correct fix counts, not only the listed "correct".
  - "partly": the learner changed it but it is still not fully correct.
  - "missed": the mistake is still there, unchanged or replaced by another error.
  "learner_text" is what the learner's text says at that place now, copied exactly. "comment" is one short sentence, only for "partly" or "missed": what is still wrong.
- "errors" lists every language error left in the learner's final text: each planted mistake that is "partly" or "missed", and any new error the learner made while editing. A correct change the learner made that was not planted is not an error. "original" is copied exactly from the learner's text.
- "corrected_text" is the learner's text with only the remaining errors fixed.
- "strengths" can name planted mistakes the learner found that are easy to miss.
</exercise_type>
