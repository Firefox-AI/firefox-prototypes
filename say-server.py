#!/usr/bin/env python3
"""
Minimal say-server for the voice-output prototype.
Wraps macOS `say` command, matching the say-reader extension's HTTP API.

Endpoints:
  POST /say          { text, rate }  — start speaking
  POST /say/pause                    — pause (kills process, saves position)
  POST /say/resume                   — resume (restarts from saved position)
  POST /say/stop                     — stop
  GET  /say/word                     — current word index + status
"""

import http.server
import json
import subprocess
import threading
import re
import time

PORT = 8744

process = None
process_lock = threading.Lock()
words = []
current_word_index = -1
status = "idle"
full_text = ""
full_rate = 175
pause_word_index = -1


def split_words(text):
    return [(m.start(), m.group()) for m in re.finditer(r'\S+', text)]


def estimate_word_duration(rate):
    return 60.0 / rate


def monitor_process():
    global process, status, current_word_index
    word_dur = estimate_word_duration(full_rate)
    while True:
        with process_lock:
            if process is None or status != "playing":
                break
            poll = process.poll()
            if poll is not None:
                status = "idle"
                process = None
                break
        time.sleep(word_dur)
        with process_lock:
            if status == "playing" and current_word_index < len(words) - 1:
                current_word_index += 1


def _kill_process():
    global process
    if process:
        try:
            process.kill()
            process.wait(timeout=2)
        except Exception:
            pass
        process = None


def start_say(text, rate=175):
    global process, words, current_word_index, status, full_text, full_rate, pause_word_index
    with process_lock:
        _kill_process()
    full_text = text
    full_rate = rate
    pause_word_index = -1
    words = split_words(text)
    current_word_index = 0 if words else -1
    _launch_say(text, rate)


def _launch_say(text, rate):
    global process, status
    try:
        process = subprocess.Popen(
            ["say", "-r", str(rate)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        process.stdin.write(text.encode("utf-8"))
        process.stdin.close()
        status = "playing"
        t = threading.Thread(target=monitor_process, daemon=True)
        t.start()
    except Exception as e:
        status = "idle"
        print(f"Error starting say: {e}")


def stop_say():
    global process, status, current_word_index, pause_word_index
    with process_lock:
        _kill_process()
        status = "idle"
        current_word_index = -1
        pause_word_index = -1


def pause_say():
    global process, status, pause_word_index, current_word_index
    with process_lock:
        if process and status == "playing":
            pause_word_index = current_word_index
            _kill_process()
            status = "paused"


def resume_say():
    global status, current_word_index, pause_word_index
    if status != "paused" or pause_word_index < 0:
        return
    idx = min(pause_word_index, len(words) - 1)
    if idx < 0:
        return
    char_offset = words[idx][0]
    remaining = full_text[char_offset:]
    current_word_index = idx
    status = "playing"
    _launch_say(remaining, full_rate)


class SayHandler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/say/word":
            idx = current_word_index
            char_index = words[idx][0] if 0 <= idx < len(words) else -1
            self._json({"index": char_index, "status": status})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/say":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get("text", "")
            rate = body.get("rate", 175)
            if text:
                start_say(text, rate)
                self._json({"ok": True, "status": "playing"})
            else:
                self._json({"ok": False, "error": "no text"}, 400)
        elif self.path == "/say/pause":
            pause_say()
            self._json({"ok": True, "status": status})
        elif self.path == "/say/resume":
            resume_say()
            self._json({"ok": True, "status": status})
        elif self.path == "/say/stop":
            stop_say()
            self._json({"ok": True, "status": "idle"})
        else:
            self._json({"error": "not found"}, 404)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = http.server.HTTPServer(("127.0.0.1", PORT), SayHandler)
    print(f"say-server listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop_say()
        server.server_close()
