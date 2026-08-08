const assert = require('node:assert/strict');
const test = require('node:test');

const {
	shouldTraverseChildFolder,
} = require('../../dist/nodes/ApsDataManagement/folderTreeHelpers.js');

test('folder traversal depth treats -1 as unlimited', () => {
	assert.equal(shouldTraverseChildFolder(0, -1), true);
	assert.equal(shouldTraverseChildFolder(10, -1), true);
});

test('folder traversal depth 0 does not descend into child folders', () => {
	assert.equal(shouldTraverseChildFolder(0, 0), false);
	assert.equal(shouldTraverseChildFolder(1, 0), false);
});

test('folder traversal positive depth descends only while current depth is below max depth', () => {
	assert.equal(shouldTraverseChildFolder(0, 1), true);
	assert.equal(shouldTraverseChildFolder(1, 1), false);
	assert.equal(shouldTraverseChildFolder(2, 3), true);
	assert.equal(shouldTraverseChildFolder(3, 3), false);
});
