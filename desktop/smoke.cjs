'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

async function verify(contents) {
  const run = source => contents.executeJavaScript(source);
  async function until(source) {
    const deadline = AbortSignal.timeout(10000);
    let last;
    while (!deadline.aborted) {
      last = await run(source);
      if (last) return last;
      await delay(40);
    }
    const notice = await run("document.querySelector('#notice').textContent");
    assert.fail(`Desktop did not reach expected state. ${notice}`);
  }
  await until("document.querySelector('#bots button')?.textContent === 'Assistant'");
  await run(`(() => {
    document.querySelector('#new-bot').click();
    const form = document.querySelector('#dialog form');
    form.elements.name.value = 'QA Bot';
    form.elements.description.value = 'Use clear wording.';
    form.requestSubmit();
  })()`);
  await until("document.querySelector('#bot-name').textContent === 'QA Bot'");
  await run("document.querySelector('#attach').click()");
  await until("document.querySelector('#attachments').textContent.includes('verification.txt')");
  await run(`(() => {
    const prompt = document.querySelector('#prompt');
    prompt.value = 'Desktop smoke test';
    prompt.dispatchEvent(new Event('input'));
    document.querySelector('#composer').requestSubmit();
  })()`);
  await until("document.querySelector('#transcript').textContent.includes('Demo reply: Desktop smoke test')");
  assert.match(await run("document.querySelector('#transcript').textContent"), /Attached: verification\.txt/);
  await run(`(() => {
    document.querySelector('#toggle-work').click();
    document.querySelector('#new-task').click();
    const form = document.querySelector('#dialog form');
    form.elements.title.value = 'Background verification';
    form.elements.prompt.value = 'Check queued execution';
    form.requestSubmit();
  })()`);
  await until("document.querySelector('#work-items').textContent.includes('Demo reply: Check queued execution')");
  await run(`(() => {
    document.querySelector('#new-schedule').click();
    const form = document.querySelector('#dialog form');
    form.elements.name.value = 'Daily verification';
    form.elements.prompt.value = 'Verify schedule';
    form.elements.frequency.value = 'daily';
    form.elements.frequency.dispatchEvent(new Event('change'));
    form.requestSubmit();
  })()`);
  await until("document.querySelector('#work-items').textContent.includes('Daily verification')");
  if (process.env.GROK_DESKTOP_SCREENSHOT) {
    const image = await contents.capturePage();
    fs.writeFileSync(process.env.GROK_DESKTOP_SCREENSHOT, image.toPNG());
  }
  await run("document.querySelector('#settings').click()");
  await until("document.querySelector('#dialog').textContent.includes('Connected as Demo model')");
  assert.equal(await run("typeof require"), 'undefined');
  console.log('Desktop smoke test passed: created a Bot, attached a file, sent chat, completed background work, saved a schedule, and opened Settings.');
}
module.exports = { verify };
