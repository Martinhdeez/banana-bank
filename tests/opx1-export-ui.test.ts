import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, exportUrl } from '../src/ui-helpers';

// OPX1-ui: the export menu downloads from OPX1-api and saves under the server's file name.
test('OPX1-ui export URL per format, id encoded', () => {
  assert.equal(exportUrl('abc-123', 'json'), '/api/incidents/abc-123/export?format=json');
  assert.equal(exportUrl('abc-123', 'html'), '/api/incidents/abc-123/export?format=html');
  assert.equal(exportUrl('a/b?c', 'json'), '/api/incidents/a%2Fb%3Fc/export?format=json');
});

test('OPX1-ui file name from Content-Disposition, fallback otherwise', () => {
  assert.equal(
    attachmentName('attachment; filename="case-4K2Q9Z-20260930.json"', 'case.json'),
    'case-4K2Q9Z-20260930.json',
  );
  assert.equal(attachmentName(null, 'case.html'), 'case.html');
  assert.equal(attachmentName('attachment', 'case.html'), 'case.html');
});
