# Credits and licences

AllHail is free software under the **GNU General Public License v3.0 or later** (see [`LICENSE`](LICENSE)). Its full source code is public in this repository.

It switched from CC0 to GPL-3.0 in November 2026 because it ships **eSpeak NG**, which is GPL-3.0. Kokoro's `phonemizer` package is built from it, and Piper's phonemizer is too.

AllHail is free and non-commercial. **Don't sell it or charge for it** while it uses the Piper voice below, whose licence forbids commercial use.

**Keep this file up to date.** Any new library, model, voice or data file that ships to users gets a row here in the same pull request. The app's About panel should link to this file.

## Voices and speech models

| Component | Used for | Licence | Credit and source |
|---|---|---|---|
| Kokoro-82M | Kokoro voice | Apache-2.0 | hexgrad, [huggingface.co/hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M); ONNX export [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| eSpeak NG (via `phonemizer`, and Piper's phonemizer) | Turning text into speech sounds for Kokoro and Piper | GPL-3.0-or-later | [github.com/espeak-ng/espeak-ng](https://github.com/espeak-ng/espeak-ng) |
| Piper voice `en_US-hfc_female-medium` | Piper voice | CC BY-NC-SA 4.0 (dataset) | Hi-Fi-CAPTAIN corpus, NICT ([ast-astrec.nict.go.jp/en/release/hi-fi-captain](https://ast-astrec.nict.go.jp/en/release/hi-fi-captain/)); fine-tuned from the Hi-Fi TTS voice of Cori Samuel; model by Rhasspy Piper ([huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)). Non-commercial use only; adaptations must share alike |

## Libraries shipped to the browser

| Library | Licence | Source |
|---|---|---|
| `kokoro-js` | Apache-2.0 | [github.com/hexgrad/kokoro](https://github.com/hexgrad/kokoro) |
| `phonemizer` | Apache-2.0 (package); contains eSpeak NG, GPL-3.0-or-later | [github.com/xenova/phonemizer.js](https://github.com/xenova/phonemizer.js) |
| `@huggingface/transformers` | Apache-2.0 | [github.com/huggingface/transformers.js](https://github.com/huggingface/transformers.js) |
| `onnxruntime-web` | MIT | [github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| `@mintplex-labs/piper-tts-web` | MIT | [npmjs.com/package/@mintplex-labs/piper-tts-web](https://www.npmjs.com/package/@mintplex-labs/piper-tts-web) |
| `@diffusionstudio/piper-wasm` | MIT (package); contains eSpeak NG, GPL-3.0-or-later | [github.com/diffusion-studio/piper-wasm](https://github.com/diffusion-studio/piper-wasm) |
| `@breezystack/lamejs` | LGPL-3.0 | [github.com/shijinyu/lamejs](https://github.com/shijinyu/lamejs) |
| React, React DOM | MIT | [github.com/facebook/react](https://github.com/facebook/react) |
| Workbox (via `vite-plugin-pwa`) | MIT | [github.com/GoogleChrome/workbox](https://github.com/GoogleChrome/workbox) |

## Server

| Library | Licence | Source |
|---|---|---|
| Express | MIT | [github.com/expressjs/express](https://github.com/expressjs/express) |
| dotenv | BSD-2-Clause | [github.com/motdotla/dotenv](https://github.com/motdotla/dotenv) |

## Services

Photo descriptions are written by AI models reached through [OpenRouter](https://openrouter.ai): Anthropic Claude Haiku, Z.ai GLM and Google Gemini Flash-Lite. Their outputs are covered by each provider's terms, not by this licence.
