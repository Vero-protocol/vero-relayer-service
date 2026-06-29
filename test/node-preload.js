// Preload hook for Node's test runner to mock ioredis before other modules load.
const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
const mockPath = path.resolve(__dirname, '__mocks__/ioredis.js');

Module._load = function(request, parent, isMain) {
  if (request === 'ioredis') {
    return originalLoad.call(this, mockPath, parent, isMain);
  }
  return originalLoad.apply(this, arguments);
};
