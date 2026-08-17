MIT License

Copyright (c) 2024 llblab (https://github.com/llblab/pi-telegram)
Copyright (c) 2024 badlogic (https://github.com/badlogic/pi-telegram)

The Telegram Bot API transport, queue discipline, pairing flow, polling
algorithm, and Markdown-to-HTML rendering in main/services/telegram/ are
adapted from pi-telegram, a fork of badlogic/pi-telegram, both MIT-licensed.

The original Pi-SDK host contract (sendUserMessage, isIdle,
hasPendingMessages, lifecycle events) is replaced by Aiden's own
llmClient turn-injection shim (telegram-turn.ts). Threaded-Mode,
companion-extension, and Pi extension-loader code from the original
project are not included.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
