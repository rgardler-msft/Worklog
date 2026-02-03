import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Status/stage validation inventory', () => {
  it('documents known rules and sources', () => {
    const docPath = path.resolve(
      process.cwd(),
      'docs',
      'validation',
      'status-stage-inventory.md'
    );
    const contents = fs.readFileSync(docPath, 'utf-8');

    expect(contents).toContain('Status/Stage Validation Rules Inventory');
    expect(contents).toContain('Status -> Allowed Stages');
    expect(contents).toContain('Stage -> Allowed Statuses');
    expect(contents).toContain('src/tui/status-stage-rules.ts');
    expect(contents).toContain('Gaps and Ambiguities');
  });
});
