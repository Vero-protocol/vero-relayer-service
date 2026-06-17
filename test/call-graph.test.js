const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('path');
const { generateCallGraph, stripComments } = require('../src/services/call-graph');

test('call graph utility tests', async (t) => {
  await t.test('stripComments cleans line and block comments', () => {
    const code = `
      // This is a comment
      fn foo() {
        /* block comment */
        let x = 5;
      }
    `;
    const cleaned = stripComments(code);
    assert.ok(!cleaned.includes('This is a comment'));
    assert.ok(!cleaned.includes('block comment'));
    assert.ok(cleaned.includes('fn foo()'));
    assert.ok(cleaned.includes('let x = 5;'));
  });

  await t.test('generateCallGraph returns accurate nodes and edges for vero-admin contract', () => {
    const contractsDir = path.join(__dirname, '../contracts');
    const result = generateCallGraph(contractsDir);

    assert.ok(result.nodes && Array.isArray(result.nodes));
    assert.ok(result.edges && Array.isArray(result.edges));

    // Verify parent nodes exist
    const parentIds = result.nodes.filter(n => n.data.isParent).map(n => n.data.id);
    assert.ok(parentIds.includes('lib'));
    assert.ok(parentIds.includes('admin'));

    // Verify function nodes exist
    const functionIds = result.nodes.filter(n => !n.data.isParent).map(n => n.data.id);
    assert.ok(functionIds.includes('lib::initialize'));
    assert.ok(functionIds.includes('admin::initialize'));
    assert.ok(functionIds.includes('admin::approve_action'));
    assert.ok(functionIds.includes('admin::execute_action'));

    // Verify some specific attributes
    const initNode = result.nodes.find(n => n.data.id === 'lib::initialize');
    assert.strictEqual(initNode.data.isPublic, true);
    assert.strictEqual(initNode.data.parent, 'lib');

    // Verify specific edges exist
    const edges = result.edges.map(e => `${e.data.source}->${e.data.target}`);
    
    // lib::initialize calls admin::initialize
    assert.ok(edges.includes('lib::initialize->admin::initialize'));
    
    // lib::get_admins calls admin::get_admins
    assert.ok(edges.includes('lib::get_admins->admin::get_admins'));
    
    // admin::approve_action calls admin::execute_action
    assert.ok(edges.includes('admin::approve_action->admin::execute_action'));
  });
});
