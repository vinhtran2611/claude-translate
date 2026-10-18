import type { Feature } from '../../../shared/server/http.ts';

export function createPracticeFeature(_options: { database_path: string }): Feature {
  return { name: 'practice', handle: async () => false };
}
