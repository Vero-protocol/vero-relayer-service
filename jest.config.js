module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Preload ts-node so runtime requires of .ts files work as well
  setupFiles: ['ts-node/register', '<rootDir>/test/jest.setup.js'],
  // Map ioredis imports to our in-repo mock implementation
  moduleNameMapper: {
    '^ioredis$': '<rootDir>/test/__mocks__/ioredis.js'
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest'
  }
};
