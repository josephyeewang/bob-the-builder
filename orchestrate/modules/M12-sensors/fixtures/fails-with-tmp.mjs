// A test file that makes a throwaway folder and then fails, for test-tmp.test.mjs: the folder must still be removed.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { tempFolders } from '../test-tmp.mjs';

const tmp = tempFolders();
test('makes a folder, then fails', () => {
  writeFileSync(`${tmp('fail-')}/planted`, 'x');
  throw new Error('planted failure');
});
