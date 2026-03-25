# ZEB — Amazon Connect WebRTC Call Widget: Full Rundown

## What We Built

A custom web call button on a static GitHub Pages HTML page that connects a customer
directly to an Amazon Connect agent via WebRTC audio (and optional video), with no
Amazon Connect hosted widget UI involved at all.

---

## The Journey — What We Tried and Why It Changed

### Attempt 1 — Hosted Widget Snippet (Option 1)

The original page used the Amazon Connect hosted widget snippet:

```js
(function(w, d, x, id){ ... })(window, document, 'amazon_connect', 'widget-id');
amazon_connect('snippetId', '...');
```

This loaded Amazon's pre-built floating phone button (green circle, bottom-right).
The goal was to hide that button and trigger the call from a custom "Call ZEB" button.

**Why it failed:**
- `amazon_connect('hide')` is a queued command that fires before the widget script
  finishes loading asynchronously — the button rendered anyway.
- `amazon_connect('open')` on button click didn't work reliably for the same reason.
- The widget's floating button is injected into the DOM with dynamic class names
  like `acWidgetContainer-0-0-31` — the number suffix changes between loads,
  making CSS targeting unreliable.

---

### Attempt 2 — MutationObserver to Hide the Widget Button

Used a `MutationObserver` watching `document.body` to catch the widget container
as soon as it was injected and set `display: none` on it. Wired the "Call ZEB"
button to find and programmatically click the widget's internal open button.

**Why it failed:**
- The entire call UI (Mute, End call, Keypad, etc.) is rendered inside an **iframe**
  (`amazon-connect-chat-widget-iframe`) served from Amazon's domain.
- Cross-origin restrictions mean JavaScript on the GitHub Pages domain cannot access
  or click any elements inside that iframe.
- There is no way to replace the widget's internal controls from outside the iframe.

---

### Attempt 3 — Direct Call to Hosted Backend Endpoint (Option 3)

Tried calling the Amazon-hosted backend endpoint directly:

```
POST https://{instance}.my.connect.aws/connectwidget/api/{widget_id}/start
```

**Why it failed:**
- Returned HTTP 400. The endpoint is not designed for raw `fetch()` calls.
- It's an internal endpoint that the widget's own JS client calls with additional
  auth context and headers that are generated during widget initialization.
- More critically: the widget was configured with `iconType: 'VOICE'` — meaning it
  uses `StartWebRTCContact` (Chime SDK WebRTC), not `StartChatContact` (ChatJS).
  These are completely different APIs and SDKs.

---

### Final Approach — Lambda + API Gateway + Chime SDK (Option 5)

**Architecture:**

```
[Call ZEB Button]
      |
      v
POST /communication-widget
(API Gateway → Lambda)
      |
      v
Lambda calls StartWebRTCContact API
(Amazon Connect Service)
      |
      v
Returns ConnectionData:
  - Meeting (MeetingId, MediaPlacement URLs)
  - Attendee (AttendeeId, JoinToken)
      |
      v
Chime SDK DefaultMeetingSession
created with ConnectionData
      |
      v
WebRTC audio session live
(no UI change, no widget)
```

---

## File Structure

```
AmazonCommunicationWidget-zeb/
├── index.html                        # Main page — custom call UI
├── libs/
│   ├── amazon-connect-chat.js        # ChatJS (downloaded, not used in final impl)
│   └── amazon-chime-sdk.min.js       # Chime SDK index (not used — loaded via esm.sh)
├── IMPLEMENTATION.md                 # Earlier implementation notes
└── RUNDOWN.md                        # This file

lambda-implementation/
├── lambda/
│   ├── startWebRTCContact.js         # Lambda code (CommonJS, Node.js 20.x)
│   └── startWebRTCContact.mjs        # Lambda code (ES Module variant)
├── api-gateway/
│   └── api-definition.json           # OpenAPI 3.0 spec for the API Gateway
├── iam/
│   ├── execution-role-policy.json    # IAM permissions (not needed — existing role used)
│   └── trust-policy.json             # IAM trust policy (not needed — existing role used)
└── DEPLOY.md                         # Step-by-step deployment guide
```

---

## AWS Resources Deployed

| Resource | Name / Detail |
|----------|--------------|
| Lambda | `zeb-eus1-ct-sowmiya-a-lambda-poc` |
| Runtime | Node.js 20.x |
| Handler | `index.handler` |
| API Gateway | Existing REST API, new resource `/communication-widget` |
| Stage | `dev` |
| IAM Role | Existing role with full Amazon Connect access (reused) |

### Lambda Environment Variables

| Key | Value |
|-----|-------|
| `INSTANCE_ID` | Amazon Connect instance UUID |
| `CONTACT_FLOW_ID` | Contact flow UUID |
| `REGION` | `us-east-1` |

### API Gateway Endpoint

```
POST https://1527omusic.execute-api.us-east-1.amazonaws.com/dev/communication-widget
```

Two methods on `/communication-widget`:
- `POST` — Lambda proxy integration → `startWebRTCContact` Lambda
- `OPTIONS` — Mock integration → returns CORS preflight headers

---

## Lambda Function — What It Does

1. Receives POST from API Gateway with `ParticipantDetails.DisplayName` in the body
2. Calls `StartWebRTCContact` AWS SDK command with `InstanceId` and `ContactFlowId`
   from environment variables
3. Amazon Connect creates a WebRTC contact and returns Chime SDK credentials
4. Lambda returns `ContactId`, `ParticipantId`, `ParticipantToken`, and `ConnectionData`
   to the browser

`ConnectionData` contains:
- `Meeting` — `MeetingId`, `MediaRegion`, `MediaPlacement` (WebSocket/TURN URLs)
- `Attendee` — `AttendeeId`, `JoinToken`

These are passed directly to the Chime SDK to join the call.

---

## Frontend — index.html

### Libraries Used

| Library | How Loaded |
|---------|-----------|
| Bootstrap 5.3 | CDN (CSS + JS) |
| Amazon Chime SDK JS v3 | `esm.sh` ES module import (no bundler needed) |

### Call Flow in the Browser

1. User clicks **Start Call**
2. `fetch()` POSTs to the API Gateway endpoint
3. Response `ConnectionData.Meeting` and `ConnectionData.Attendee` are extracted
4. Chime SDK `DefaultMeetingSession` is created with `MeetingSessionConfiguration`
5. Default microphone is selected via `listAudioInputDevices()`
6. A hidden `<audio>` element is created and bound for audio output
7. A single observer is registered for `audioVideoDidStop` and `videoTileDidUpdate`
8. `meetingSession.audioVideo.start()` initiates the WebRTC connection
9. Agent receives the call in their CCP

### Custom Controls

| Button | Action |
|--------|--------|
| Start Call | Calls Lambda, creates Chime session, starts audio |
| End Call | Calls `audioVideo.stop()`, cleans up session |
| Mute | `realtimeMuteLocalAudio()` — toggles label/style |
| Unmute | `realtimeUnmuteLocalAudio()` — toggles label/style |
| Start Video | `startVideoInput()` + `startLocalVideoTile()` — shows preview |
| Stop Video | `stopLocalVideoTile()` + `stopVideoInput()` — hides preview |

### Bug Fixed

The `videoTileDidUpdate` observer was originally registered inside `startVideoLocal()`
which caused it to fire after `meetingSession` was set to `null` on end call, throwing:

```
Cannot read properties of null (reading 'audioVideo')
```

Fix: moved the observer registration to session creation time (alongside
`audioVideoDidStop`), added a `if (!meetingSession) return` guard, and removed
the duplicate registration from `startVideoLocal()`.

---

## CORS

Two separate CORS concepts in this project:

| CORS Type | What It Controls |
|-----------|-----------------|
| Amazon Connect widget allowlist | Which domains can load the hosted widget iframe |
| API Gateway `Access-Control-Allow-Origin: *` | Which domains can `fetch()` the Lambda endpoint |

The Lambda returns `Access-Control-Allow-Origin: *` in every response, allowing
the GitHub Pages domain to call the API from the browser without restriction.

---

## Cost Estimate (Monthly)

| Service | Free Tier | Cost Beyond Free Tier |
|---------|----------|-----------------------|
| IAM | Always free | $0 |
| Lambda | 1M requests + 400K GB-sec (permanent) | ~$0.20/M requests |
| API Gateway (REST) | 1M requests for 12 months | $3.50/M requests |

For typical usage (hundreds to low thousands of calls/month): **effectively $0**.
