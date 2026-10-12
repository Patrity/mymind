# How do I make my Discord bot ignore previous messages after a restart?

**Question** (asked 3 years ago)

When my bot restarts it processes every message in the channel history again and replies to old commands. How can I make it ignore previous messages and only respond to new ones?

**Answer** (score 42)

Store the timestamp when the bot becomes ready and ignore any message created before it:

```js
let readyAt
client.once('ready', () => { readyAt = Date.now() })
client.on('messageCreate', msg => {
  if (msg.createdTimestamp < readyAt) return // ignore previous messages
  handle(msg)
})
```

**Answer** (score 7)

You're probably fetching history on startup somewhere. Remove the `channel.messages.fetch()` call in your ready handler — the gateway only sends new messages by default.

**Comment:** That was it, thanks! I had copied the fetch from an old tutorial.
