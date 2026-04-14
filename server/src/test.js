const config = require('../config/default');
const logger = require('./utils/logger');

/**
 * Test co ban de kiem tra cau hinh
 */
async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, condition) {
    if (condition) {
      logger.info(`PASS: ${name}`);
      passed++;
    } else {
      logger.error(`FAIL: ${name}`);
      failed++;
    }
  }

  // Test config
  test('Telegram token duoc cau hinh', !!config.telegram.token && config.telegram.token !== 'your_bot_token_here');
  test('Allowed users duoc cau hinh', config.telegram.allowedUsers.length > 0 && !isNaN(config.telegram.allowedUsers[0]));
  test('Playwright config hop le', config.playwright.slowMo > 0);
  test('Posting limits hop le', config.posting.maxPostsPerDay > 0);

  // Test modules load
  try {
    require('./api/facebook-graph');
    test('Module facebook-graph load OK', true);
  } catch (e) {
    test('Module facebook-graph load OK', false);
  }

  try {
    require('./playwright/post');
    test('Module playwright/post load OK', true);
  } catch (e) {
    test('Module playwright/post load OK', false);
  }

  logger.info(`\nKet qua: ${passed} passed, ${failed} failed`);
}

runTests();
