// Mock vscode module for tests
jest.mock('vscode', () => ({
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key, defaultValue) => defaultValue),
    })),
  },
  env: {
    appName: 'Visual Studio Code',
  },
  extensions: {
    getExtension: jest.fn(() => undefined),
  },
  RemoteAuthorityResolver: jest.fn(),
  Disposable: jest.fn(),
  EventEmitter: jest.fn(),
  Uri: {
    parse: jest.fn((uri) => ({ toString: () => uri })),
  },
  window: {
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
    })),
  },
  commands: {
    registerCommand: jest.fn(),
    executeCommand: jest.fn(),
  },
  ConfigurationTarget: {
    Global: 1,
  },
}), { virtual: true });

// Mock @kubernetes/client-node module for tests
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn(),
  Exec: jest.fn(),
  V1Status: jest.fn(),
}), { virtual: true });
