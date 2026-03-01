const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 800, height: 700 },
  },
  webServer: {
    command: 'npx serve . -p 3456 --no-clipboard',
    url: 'http://localhost:3456',
    reuseExistingServer: false,
    timeout: 10000,
  },
});
