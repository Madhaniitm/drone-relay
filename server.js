const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'changeme-device-secret';
const CONTROL_KEY = process.env.CONTROL_KEY || 'changeme-control-key';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.set('trust proxy', true); // Render sits behind a proxy; needed for req.protocol to report https
// The React widget runs on Kissflow's own domain, so calls into this relay
// are cross-origin. The X-Control-Key/X-Device-Secret checks are the real
// gate, so allowing any origin here is fine.
app.use(cors());
app.use(express.json());

let lastFrame = null;
const command = { motor1: 0, motor2: 0 };

function requireDeviceSecret(req, res, next) {
  if (req.get('X-Device-Secret') !== DEVICE_SECRET) return res.sendStatus(401);
  next();
}

function requireControlKey(req, res, next) {
  const key = req.get('X-Control-Key') || req.query.key;
  if (key !== CONTROL_KEY) return res.sendStatus(401);
  next();
}

app.get('/', (req, res) => res.send('drone relay ok'));

// --- Drone -> relay ---
app.post('/frame', requireDeviceSecret, express.raw({ type: 'image/jpeg', limit: '2mb' }), (req, res) => {
  lastFrame = req.body;
  res.sendStatus(204);
});

app.get('/command', requireDeviceSecret, (req, res) => {
  res.json(command);
});

// --- Kissflow panel -> relay ---
app.post('/command', requireControlKey, (req, res) => {
  const { motor, speed } = req.body || {};
  const clamped = Math.max(0, Math.min(255, Number(speed) || 0));
  console.log(`slider command received: motor ${motor} -> ${clamped}`);
  if (motor === 1) command.motor1 = clamped;
  else if (motor === 2) command.motor2 = clamped;
  else return res.sendStatus(400);
  res.sendStatus(204);
});

app.get('/snapshot.jpg', requireControlKey, (req, res) => {
  if (!lastFrame) return res.sendStatus(503);
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(lastFrame);
});

app.get('/verbalize', async (req, res) => {
  if (!lastFrame) return res.sendStatus(503);
  const imageUrl = `${req.protocol}://${req.get('host')}/snapshot.jpg?key=${CONTROL_KEY}`;
  try {
    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: "Describe what's visible in this drone camera image in one or two sentences." },
            { inlineData: { mimeType: 'image/jpeg', data: lastFrame.toString('base64') } },
          ],
        },
      ],
    });
    const usage = response.usageMetadata || {};
    res.json({
      caption: response.text ?? '',
      image_url: imageUrl,
      model: response.modelVersion ?? '',
      response_id: response.responseId ?? '',
      finish_reason: response.candidates?.[0]?.finishReason ?? '',
      prompt_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
      thoughts_tokens: usage.thoughtsTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
      captured_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('verbalize failed:', err);
    res.status(500).json({ error: 'verbalize failed', detail: String(err) });
  }
});

app.get('/panel', requireControlKey, (req, res) => {
  const key = req.query.key;
  res.set('Content-Type', 'text/html');
  res.send(panelHtml(key));
});

function panelHtml(key) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0">
<style>
  body { font-family: sans-serif; text-align: center; margin: 0; padding: 16px; background: #111; color: #eee; }
  img { width: 100%; max-width: 480px; border-radius: 8px; background: #222; }
  input[type=range] {
    -webkit-appearance: none;
    width: 260px;
    height: 36px;
    background: #7d7d7d;
    margin: 12px;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 36px;
    height: 36px;
    background: #0048ff;
    border: 2px solid #333;
    border-radius: 50%;
  }
  .sliders { display: flex; justify-content: center; align-items: center; }
</style>
</head>
<body>
  <img id="cam" src="/snapshot.jpg?key=${key}">
  <div class="sliders">
    <input type="range" min="0" max="255" value="0" style="writing-mode: bt-lr; transform: rotate(270deg);" oninput="sendCommand(1, this.value)">
    <input type="range" min="0" max="255" value="0" style="writing-mode: bt-lr; transform: rotate(270deg);" oninput="sendCommand(2, this.value)">
  </div>
<script>
  const key = ${JSON.stringify(key)};
  setInterval(() => {
    document.getElementById('cam').src = '/snapshot.jpg?key=' + key + '&t=' + Date.now();
  }, 300);

  function sendCommand(motor, speed) {
    fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Control-Key': key },
      body: JSON.stringify({ motor, speed: Number(speed) })
    });
  }
</script>
</body>
</html>`;
}

app.listen(PORT, () => console.log('Relay listening on port ' + PORT));
