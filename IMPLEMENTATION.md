# Amazon Connect Custom Call Button — Implementation Notes

## What Changed and Why

### The Problem with the Hosted Widget Snippet

The original implementation used the Amazon Connect hosted widget snippet:

```js
(function(w, d, x, id){ ... })(window, document, 'amazon_connect', 'widget-id');
amazon_connect('snippetId', '...');
```

This approach loads Amazon's pre-built UI (the floating green phone button) as a black box iframe. The widget controls its own rendering and does not expose a reliable public API to:
- Suppress the floating button before it renders
- Trigger the call programmatically from an external button

`amazon_connect('hide')` and `amazon_connect('open')` are queued commands that depend on the widget's internal load lifecycle. The widget script is loaded asynchronously, so these commands often fire before the widget is ready, or the widget re-renders its button regardless.

---

## The New Approach — Option 3 (Direct Hosted Backend)

Instead of using the widget snippet, we bypass the widget UI entirely and call Amazon Connect's hosted backend endpoint directly.

### Architecture

```
[Call ZEB Button Click]
        |
        v
POST /connectwidget/api/{widget_id}/start
(Amazon-hosted backend, no Lambda needed)
        |
        v
Returns: ContactId, ParticipantId, ParticipantToken
        |
        v
connect.ChatSession.create() — ChatJS
        |
        v
chatSession.connect() — WebSocket established
        |
        v
Voice/Chat session live (no UI change)
```

---

## Key Files

| File | Purpose |
|------|---------|
| `index.html` | Main page with Call ZEB button and ChatJS session logic |
| `libs/amazon-connect-chat.js` | ChatJS bundle loaded locally (downloaded from unpkg) |

---

## Configuration Values

These are pulled from the original widget snippet and stored in `AC_CONFIG` in `index.html`:

| Key | Value |
|-----|-------|
| `instanceAlias` | `nova-sonic-connect-poc` |
| `widgetId` | `a2bc9174-3fe1-4ed0-96ae-c945223ab982` |
| `snippetId` | Long base64 string — used as `x-amz-snippet-id` header |
| `region` | `us-east-1` |

---

## Hosted Backend Endpoint

```
POST https://{instanceAlias}.my.connect.aws/connectwidget/api/{widgetId}/start
```

**Required Headers:**
- `Content-Type: application/json`
- `x-amz-snippet-id: {snippetId}`

**Response shape (expected):**
```json
{
  "startChatResult": {
    "ContactId": "...",
    "ParticipantId": "...",
    "ParticipantToken": "..."
  }
}
```

> Note: The actual response shape may vary. The code handles `data.startChatResult`, `data.data.startChatResult`, or `data` directly as fallbacks.

---

## Call Flow in Code

### 1. Button Click → `startCall()`
- Disables the button and shows "Connecting..."
- POSTs to the hosted backend endpoint
- Extracts `ContactId`, `ParticipantId`, `ParticipantToken` from response

### 2. ChatJS Session Creation
```js
activeChatSession = connect.ChatSession.create({
    chatDetails: { contactId, participantId, participantToken },
    options: { region },
    type: connect.ChatSession.SessionTypes.CUSTOMER,
    disableCSM: true
});
await activeChatSession.connect();
```

### 3. Button becomes "End Call" → `endCall()`
- Calls `activeChatSession.disconnectParticipant()`
- Resets button back to "Call ZEB"

### 4. Session Events Handled
| Event | Action |
|-------|--------|
| `onConnectionEstablished` | Logs to console |
| `onEnded` | Resets button (agent ended call) |
| `onConnectionLost` | Logs warning |

---

## Prerequisites for This to Work

1. **GitHub Pages domain must be allowlisted** in the Amazon Connect widget configuration under the Connect console → Application Integration. Without this, the browser will block the POST request due to CORS.

2. **The widget must be configured** in the Connect console (Admin Guide: [Add chat to website](https://docs.aws.amazon.com/connect/latest/adminguide/config-com-widget1.html)) — the hosted backend endpoint only works if a communication widget exists for the given `widgetId`.

3. **ChatJS local bundle** must be present at `libs/amazon-connect-chat.js`. Re-download if needed:
   ```
   curl -o libs/amazon-connect-chat.js https://unpkg.com/amazon-connect-chatjs@latest/dist/amazon-connect-chat.js
   ```

---

## Troubleshooting

| Symptom | Likely Cause |
|---------|-------------|
| Button clicks but nothing happens | Check browser console for CORS errors or 4xx from the endpoint |
| `connect is not defined` | `libs/amazon-connect-chat.js` not loading — check file path |
| `ContactId undefined` | Response shape differs — log `data` in console and adjust the extraction path in `startCall()` |
| 403 from endpoint | `snippetId` header is wrong or domain not allowlisted |
