import {
    ConsoleLogger,
    DefaultDeviceController,
    DefaultMeetingSession,
    LogLevel,
    MeetingSessionConfiguration,
    MeetingSessionStatusCode
} from 'https://esm.sh/amazon-chime-sdk-js@3';

const API_ENDPOINT = 'https://1527omusic.execute-api.us-east-1.amazonaws.com/dev/communication-widget';

// --- State ---
let meetingSession = null;
let isMuted = false;
let isVideoOn = false;

// --- DOM refs ---
const btnStart = document.getElementById('btnStart');
const btnEnd = document.getElementById('btnEnd');
const btnMute = document.getElementById('btnMute');
const btnVideo = document.getElementById('btnVideo');
const callStatus = document.getElementById('callStatus');
const localVideo = document.getElementById('local-video');
const labelMute = document.getElementById('labelMute');
const labelVideo = document.getElementById('labelVideo');

// --- Helpers ---
function setStatus(msg, type = '') {
    callStatus.textContent = msg;
    callStatus.className = 'call-status' + (type ? ' ' + type : '');
}

function setCallActive(active) {
    btnStart.disabled = active;
    btnEnd.disabled = !active;
    btnMute.disabled = !active;
    btnVideo.disabled = !active;
}

// --- Start Call ---
btnStart.addEventListener('click', async () => {
    setStatus('Connecting...', '');
    btnStart.disabled = true;

    try {
        // 1. Call Lambda via API Gateway
        const res = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ParticipantDetails: {
                    DisplayName: 'ZEB Customer'
                }
            })
        });

        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data = await res.json();

        const {
            Meeting,
            Attendee
        } = data.ConnectionData;

        // 2. Configure Chime SDK session
        const logger = new ConsoleLogger('ZEB-Chime', LogLevel.WARN);
        const deviceController = new DefaultDeviceController(logger);
        const config = new MeetingSessionConfiguration({
            Meeting
        }, {
            Attendee
        });

        meetingSession = new DefaultMeetingSession(config, logger, deviceController);

        // 3. Select default audio input (microphone)
        const audioInputs = await meetingSession.audioVideo.listAudioInputDevices();
        if (audioInputs.length > 0) {
            await meetingSession.audioVideo.startAudioInput(audioInputs[0].deviceId);
        }

        // 4. Bind audio output to a hidden element
        const audioEl = document.createElement('audio');
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        meetingSession.audioVideo.bindAudioElement(audioEl);

        // 5. Register observer once — handles session end and video tile binding
        meetingSession.audioVideo.addObserver({
            audioVideoDidStop(status) {
                const code = status.statusCode();
                const shouldReset =
                    code === MeetingSessionStatusCode.MeetingEnded ||
                    code === MeetingSessionStatusCode.Left ||
                    code === MeetingSessionStatusCode.SignalingChannelClosedUnexpectedly ||
                    code === MeetingSessionStatusCode.SignalingBadRequest ||
                    code === MeetingSessionStatusCode.TaskFailed;

                if (shouldReset) {
                    const wasUnexpected = code === MeetingSessionStatusCode.SignalingChannelClosedUnexpectedly;
                    setStatus(wasUnexpected ? 'Call disconnected unexpectedly' : 'Call ended', wasUnexpected ? 'error' : '');
                    setCallActive(false);
                    stopVideoLocal();
                    meetingSession = null;
                }
            },
            videoTileDidUpdate(tileState) {
                if (!meetingSession) return;
                if (tileState.localTile) {
                    meetingSession.audioVideo.bindVideoElement(tileState.tileId, localVideo);
                    localVideo.style.display = 'block';
                }
            }
        });

        // 6. Start the WebRTC audio session
        meetingSession.audioVideo.start();

        setStatus('Connected', 'active');
        setCallActive(true);
        isMuted = false;
        isVideoOn = false;
        syncMuteUI();
        syncVideoUI();

    } catch (err) {
        console.error('Start call failed:', err);
        setStatus('Failed to connect — ' + err.message, 'error');
        btnStart.disabled = false;
    }
});

// --- End Call ---
btnEnd.addEventListener('click', async () => {
    if (!meetingSession) return;
    await stopVideoLocal();
    meetingSession.audioVideo.stop();
    setStatus('Call ended', '');
    setCallActive(false);
    meetingSession = null;
});

// --- Mute / Unmute ---
btnMute.addEventListener('click', () => {
    if (!meetingSession) return;
    if (isMuted) {
        meetingSession.audioVideo.realtimeUnmuteLocalAudio();
        isMuted = false;
    } else {
        meetingSession.audioVideo.realtimeMuteLocalAudio();
        isMuted = true;
    }
    syncMuteUI();
});

function syncMuteUI() {
    if (isMuted) {
        labelMute.textContent = 'Unmute';
        btnMute.classList.remove('active');
        btnMute.classList.add('off');
    } else {
        labelMute.textContent = 'Mute';
        btnMute.classList.add('active');
        btnMute.classList.remove('off');
    }
}

// --- Enable / Disable Video ---
btnVideo.addEventListener('click', async () => {
    if (!meetingSession) return;
    if (isVideoOn) {
        await stopVideoLocal();
    } else {
        await startVideoLocal();
    }
});

async function startVideoLocal() {
    try {
        const videoInputs = await meetingSession.audioVideo.listVideoInputDevices();
        if (videoInputs.length === 0) {
            setStatus('No camera found', 'error');
            return;
        }
        await meetingSession.audioVideo.startVideoInput(videoInputs[0].deviceId);
        meetingSession.audioVideo.startLocalVideoTile();
        isVideoOn = true;
        syncVideoUI();
    } catch (err) {
        console.error('Video start failed:', err);
        setStatus('Camera error — ' + err.message, 'error');
    }
}

async function stopVideoLocal() {
    if (!meetingSession) return;
    try {
        meetingSession.audioVideo.stopLocalVideoTile();
        await meetingSession.audioVideo.stopVideoInput();
    } catch (_) {}
    localVideo.style.display = 'none';
    localVideo.srcObject = null;
    isVideoOn = false;
    syncVideoUI();
}

function syncVideoUI() {
    if (isVideoOn) {
        labelVideo.textContent = 'Stop Video';
        btnVideo.classList.add('active');
        btnVideo.classList.remove('off');
    } else {
        labelVideo.textContent = 'Start Video';
        btnVideo.classList.remove('active');
        btnVideo.classList.add('off');
    }
}

// --- ZEB text ripple effect ---
const zebText = document.getElementById('zebText');
zebText.addEventListener('click', function(e) {
    const ripple = document.createElement('div');
    const rect = zebText.getBoundingClientRect();
    const size = 60;
    ripple.style.cssText = `
        position:absolute;width:${size}px;height:${size}px;
        left:${e.clientX - rect.left - size / 2}px;
        top:${e.clientY - rect.top - size / 2}px;
        background:radial-gradient(circle,var(--grass-green) 0%,transparent 70%);
        border-radius:50%;transform:scale(0);
        animation:ripple 0.6s ease-out;pointer-events:none;
    `;
    zebText.style.position = 'relative';
    zebText.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
});

// --- Mouse parallax background ---
document.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth) * 100;
    const y = (e.clientY / window.innerHeight) * 100;
    document.body.style.background = `radial-gradient(circle at ${x}% ${y}%, var(--grass-green) 0%, var(--swamp-green) 50%, #2d3d0f 100%)`;
});