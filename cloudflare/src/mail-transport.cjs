const { getBindings } = require('./context.cjs');

function createMailTransport({ addressParser, htmlToText }) {
  function addresses(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.flatMap(addresses);
    if (typeof value === 'object') {
      if (value.group) return value.group.flatMap(addresses);
      if (!value.address) throw new Error('Email address is missing');
      return [{ email: value.address, ...(value.name ? { name: value.name } : {}) }];
    }
    return addressParser(value).flatMap(addresses);
  }
  function single(value, field) {
    const list = addresses(value);
    if (list.length !== 1) throw new Error(field + ' requires one email address');
    return list[0];
  }
  // Native Workers currently requires name even though the type marks it optional.
  // Include an empty display name consistently, including reply-to addresses.
  function wireAddress(address) {
    return { email: address.email, name: address.name || '' };
  }
  return {
    async sendMail(message) {
      const binding = getBindings().EMAIL;
      if (!binding) throw new Error('Cloudflare EMAIL binding is not configured');
      const to = addresses(message.to);
      const cc = addresses(message.cc);
      const bcc = addresses(message.bcc);
      const headers = {};
      for (const [name, value] of Object.entries(message.headers || {})) {
        // Ghost adds Sender to every message; the structured API uses from.
        if (name.toLowerCase() === 'sender') continue;
        if (typeof value !== 'string') throw new Error('Email header must be a string: ' + name);
        headers[name] = value;
      }
      const payload = {
        from: wireAddress(single(message.from, 'from')),
        to: to.map(wireAddress),
        subject: message.subject,
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(cc.length ? { cc: cc.map(wireAddress) } : {}),
        ...(bcc.length ? { bcc: bcc.map(wireAddress) } : {}),
        ...(message.replyTo ? { replyTo: wireAddress(single(message.replyTo, 'replyTo')) } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      if (
        message.text === undefined &&
        message.html &&
        message.generateTextFromHTML &&
        htmlToText
      ) {
        payload.text = htmlToText.fromString(message.html);
      }
      if (message.attachments?.length) {
        payload.attachments = message.attachments.map((attachment) => {
          if (attachment.path || attachment.href || attachment.raw || attachment.content == null) {
            throw new Error('Cloudflare mail attachments require explicit in-memory content');
          }
          const bytes =
            typeof attachment.content === 'string'
              ? Buffer.from(attachment.content, attachment.encoding || 'utf8')
              : Buffer.from(attachment.content);
          return {
            content: bytes.toString('base64'),
            filename: attachment.filename,
            type: attachment.contentType || 'application/octet-stream',
            disposition:
              attachment.contentDisposition || (attachment.cid ? 'inline' : 'attachment'),
            ...(attachment.cid ? { contentId: attachment.cid } : {}),
          };
        });
      }
      const result = await binding.send(payload);
      if (!result?.messageId) throw new Error('Cloudflare Email Service returned no message ID');
      return {
        messageId: result.messageId,
        accepted: [...to, ...cc, ...bcc].map((item) => item.email),
        rejected: [],
        response: 'Accepted by Cloudflare Email Service',
      };
    },
    close() {},
  };
}

module.exports = { createMailTransport };
