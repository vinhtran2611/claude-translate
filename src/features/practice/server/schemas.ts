// The JSON Schemas (draft 2020-12) at /api/practice/schemas/. They are made from the same field specs as the checks
// in import-check.ts, so they can never disagree with them. They describe format 4; format 3 is still read, but only
// described in static/import-format.md.
import {
  CONTENT_FIELDS, EXERCISE_TYPES, exerciseFields, type Fields, KEY_PATTERN, MAX_EXERCISES, PROJECT_FIELDS, type Spec, TYPE_RULES,
} from '../import-check.ts';

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

function schemaOf(spec: Spec): Record<string, unknown> {
  const description = spec.about === undefined ? {} : { description: spec.about };
  switch (spec.kind) {
    case 'text':
      return { type: 'string', minLength: 1, maxLength: spec.max, ...description };
    case 'key':
      return { type: 'string', pattern: KEY_PATTERN.source, ...description };
    case 'oneOf':
      return { enum: spec.values, ...description };
    case 'flag':
      return { type: 'boolean', ...description };
    case 'whole':
      return { type: 'integer', minimum: spec.min, maximum: spec.max, ...description };
    case 'time':
      return { type: 'string', format: 'date-time', ...description };
    case 'texts': {
      // A text, or a list of 1 to 10 texts.
      const one = { type: 'string', minLength: 1, maxLength: spec.max };
      return { oneOf: [one, { type: 'array', minItems: 1, maxItems: 10, items: one }], ...description };
    }
    case 'list':
      return { type: 'array', minItems: spec.min, maxItems: spec.max, items: schemaOf(spec.of), ...description };
    case 'object':
      return objectSchema(spec.fields, description);
  }
}

function isRequired(spec: Spec): boolean {
  return 'required' in spec && spec.required === true;
}

// A field that may be left out may also be null: both mean "use the default".
function propertySchemaOf(spec: Spec): Record<string, unknown> {
  const schema = schemaOf(spec);
  if (isRequired(spec)) return schema;
  const { description, ...shape } = schema;
  const nullable: Record<string, unknown> = { anyOf: [shape, { type: 'null' }] };
  if (description !== undefined) nullable.description = description;
  return nullable;
}

function objectSchema(fields: Fields, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = Object.entries(fields);
  const required = entries.filter(([, spec]) => isRequired(spec)).map(([key]) => key);
  const properties = Object.fromEntries(entries.map(([key, spec]) => [key, propertySchemaOf(spec)]));
  return { type: 'object', additionalProperties: false, required, ...extra, properties };
}

// One exercise type as a schema: its own content fields, with content.type fixed to it.
function exerciseTypeSchema(type: (typeof EXERCISE_TYPES)[number]): Record<string, unknown> {
  const contentSchema = objectSchema(CONTENT_FIELDS[type]);
  const contentProperties = contentSchema.properties as Record<string, unknown>;
  const content = {
    ...contentSchema,
    required: ['type', ...(contentSchema.required as string[])],
    // type comes first, as people write it.
    properties: { type: { const: type }, ...contentProperties },
  };
  const schema = objectSchema(exerciseFields(true), { description: TYPE_RULES[type] });
  const properties = schema.properties as Record<string, unknown>;
  return {
    ...schema,
    required: ['key', 'content'],
    properties: { ...properties, content },
  };
}

// GET /api/practice/schemas/exercise.json: one exercise as a file holds it, one $defs entry per type.
export function exerciseSchema(): Record<string, unknown> {
  const $defs = Object.fromEntries(EXERCISE_TYPES.map((type) => [type, exerciseTypeSchema(type)]));
  return {
    $schema: SCHEMA_DIALECT,
    $id: '/api/practice/schemas/exercise.json',
    title: 'Practice exercise',
    description:
      'In PUT /api/practice/projects/{project}/exercises/{key}, key may be left out; when present it must equal the URL key. Texts must not be only spaces. A field that may be left out may also be null.',
    oneOf: EXERCISE_TYPES.map((type) => ({ $ref: `#/$defs/${type}` })),
    $defs,
  };
}

// GET /api/practice/schemas/import.json: the import file, format 4.
export function importSchema(): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    $id: '/api/practice/schemas/import.json',
    title: 'Practice import file (format 4)',
    description: 'One file is one project. Importing it again updates the project and its exercises by key; it never deletes an exercise. Format 3 files are still read (/features/practice/static/import-format.md).',
    type: 'object',
    additionalProperties: false,
    required: ['format', 'project', 'exercises'],
    properties: {
      format: { const: 4 },
      project: objectSchema(PROJECT_FIELDS),
      exercises: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EXERCISES,
        items: { $ref: 'exercise.json' },
        description: 'Keys are unique in the file.',
      },
    },
  };
}
