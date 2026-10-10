const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withBindings } = require('../src/context.cjs');
const { createMailTransport } = require('../src/mail-transport.cjs');

const transport = createMailTransport({ addressParser: (input) => [{ address: input }] });

test('maps Ghost mail, named recipients, headers and binary attachments to the native binding', async () => {
  let sent;
  const info = await withBindings(
    {
      EMAIL: {
        send: async (payload) => {
          sent = payload;
          return { messageId: 'test-message' };
        },
      },
    },
    () =>
      transport.sendMail({
        from: { address: 'ghost@example.test', name: 'Ghost' },
        to: ['reader@example.test', { address: 'second@example.test', name: 'Reader' }],
        bcc: 'audit@example.test',
        replyTo: 'reply@example.test',
        subject: 'Login link',
        html: '<p>Sign in</p>',
        text: 'Sign in',
        headers: { Sender: 'ghost@example.test', 'X-Ghost-Test': 'yes' },
        attachments: [
          {
            filename: 'image.png',
            content: Buffer.from([0, 255, 128]),
            contentType: 'image/png',
            cid: 'logo',
          },
        ],
      }),
  );
  assert.equal(sent.from.name, 'Ghost');
  assert.equal(sent.to[1].name, 'Reader');
  assert.deepEqual(sent.headers, { 'X-Ghost-Test': 'yes' });
  assert.deepEqual(sent.attachments[0], {
    filename: 'image.png',
    content: 'AP+A',
    type: 'image/png',
    disposition: 'inline',
    contentId: 'logo',
  });
  assert.deepEqual(info.accepted, [
    'reader@example.test',
    'second@example.test',
    'audit@example.test',
  ]);
  assert.equal(info.messageId, 'test-message');
});

test('preserves delivery failure and rejects missing bindings or unsupported attachment sources', async () => {
  const message = {
    from: 'ghost@example.test',
    to: 'reader@example.test',
    subject: 'Test',
    text: 'Test',
  };
  await assert.rejects(
    withBindings({}, () => transport.sendMail(message)),
    /not configured/,
  );
  const failure = Object.assign(new Error('Sender not verified'), {
    code: 'E_SENDER_NOT_VERIFIED',
  });
  await assert.rejects(
    withBindings(
      {
        EMAIL: {
          send: async () => {
            throw failure;
          },
        },
      },
      () => transport.sendMail(message),
    ),
    (error) => error === failure,
  );
  await assert.rejects(
    withBindings({ EMAIL: { send: async () => assert.fail('must not send') } }, () =>
      transport.sendMail({ ...message, attachments: [{ path: '/tmp/private' }] }),
    ),
    /in-memory/,
  );
});
